import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { ModelGateway } from '../model-gateway/index';
import { chunkContent } from './pipeline/chunk';
import { ExtractStage } from './pipeline/extract.stage';
import type { SourceItem } from './pipeline/source-reader';
import { VerifyStage } from './pipeline/verify.stage';
import type { CandidateFact } from './domain/candidate-fact';
import { EXTRACTION_PROMPT, VERIFICATION_PROMPT } from './prompt-versions';

/**
 * The golden-set eval harness v0 (docs/eval-golden-set.md; §B.4): runs
 * ingest → chunk → extract → verify over the labeled corpus against the live
 * gateway and scores it. Stage 5 (embedding into Qdrant) is off — matching
 * uses ad-hoc embeddings only. No CI gates yet (Session 4 turns them on).
 *
 * Matching (spec §3): an extracted fact matches an expected label when the
 * embedding cosine similarity of claim vs content_gist meets the versioned
 * threshold AND the label's entities are sufficiently covered by the fact.
 *
 * Verification agreement v0 rule (spec §5, operationalized):
 * - `verification_expected: "supported"` — the case agrees when every fact
 *   matched to an expected label got verdict `supported`.
 * - `verification_expected: "unsupported"` (designed-trap cases) — the case
 *   agrees when no extracted fact OUTSIDE the expected labels was admitted as
 *   `supported`: the extractor abstaining from the trap, or the verifier
 *   demoting it, both count as the system handling the trap correctly.
 */

const expectedMemorySchema = z.object({
  content_gist: z.string().min(1),
  kind: z.string(),
  entities: z.array(z.string()).default([]),
  condition: z.string().nullable().optional(),
  temporal: z.record(z.unknown()).optional(),
  must_extract: z.boolean(),
});

const expectedFileSchema = z.object({
  case_id: z.string(),
  source_type: z.string().default('user_note'),
  /** Per-case anchor (S3.5-A): pins relative-date cases to a fixed date forever. */
  source_date: z.string().optional(),
  expected_memories: z.array(expectedMemorySchema).default([]),
  must_not_extract: z.array(z.string()).default([]),
  expected_relations: z.array(z.unknown()).default([]),
  verification_expected: z.enum(['supported', 'partial', 'unsupported']).optional(),
});

export const evalConfigSchema = z.object({
  version: z.number(),
  similarity_threshold: z.number().min(0).max(1),
  entity_overlap_threshold: z.number().min(0).max(1),
  reference_time: z.string(),
});
export type EvalConfig = z.infer<typeof evalConfigSchema>;

export interface EvalMetrics {
  label: string;
  cases: number;
  extractedFacts: number;
  matchedExtracted: number;
  mustExtractLabels: number;
  matchedMustExtract: number;
  precision: number;
  recall: number;
  verificationCases: number;
  verificationAgreed: number;
  verificationAgreement: number;
}

export interface EvalRunResult {
  perLanguage: EvalMetrics[];
  aggregate: EvalMetrics;
  config: EvalConfig;
  promptVersions: string;
  caseCount: number;
}

interface LoadedCase {
  lang: string;
  caseId: string;
  source: string;
  expected: z.infer<typeof expectedFileSchema>;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Entity coverage: a labeled entity counts when the fact names it anywhere. */
function entityOverlap(expected: string[], fact: CandidateFact): number {
  if (expected.length === 0) return 1;
  const haystack = [
    fact.claim,
    ...fact.entities.people,
    ...fact.entities.organizations,
    ...fact.entities.projects,
  ]
    .join(' ')
    .toLowerCase();
  const covered = expected.filter((entity) => haystack.includes(entity.toLowerCase()));
  return covered.length / expected.length;
}

async function loadCases(goldenDir: string): Promise<LoadedCase[]> {
  const cases: LoadedCase[] = [];
  const langs = (await readdir(goldenDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const lang of langs) {
    const caseDirs = (await readdir(path.join(goldenDir, lang), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const dir of caseDirs) {
      const base = path.join(goldenDir, lang, dir);
      const source = await readFile(path.join(base, 'source.txt'), 'utf8');
      const expected = expectedFileSchema.parse(
        JSON.parse(await readFile(path.join(base, 'expected.json'), 'utf8')),
      );
      cases.push({ lang, caseId: expected.case_id, source, expected });
    }
  }
  return cases;
}

function emptyMetrics(label: string): EvalMetrics {
  return {
    label,
    cases: 0,
    extractedFacts: 0,
    matchedExtracted: 0,
    mustExtractLabels: 0,
    matchedMustExtract: 0,
    precision: 0,
    recall: 0,
    verificationCases: 0,
    verificationAgreed: 0,
    verificationAgreement: 0,
  };
}

function finalize(metrics: EvalMetrics): EvalMetrics {
  metrics.precision =
    metrics.extractedFacts === 0 ? 1 : metrics.matchedExtracted / metrics.extractedFacts;
  metrics.recall =
    metrics.mustExtractLabels === 0 ? 1 : metrics.matchedMustExtract / metrics.mustExtractLabels;
  metrics.verificationAgreement =
    metrics.verificationCases === 0 ? 1 : metrics.verificationAgreed / metrics.verificationCases;
  return metrics;
}

export async function runGoldenEval(options: {
  gateway: ModelGateway;
  goldenDir: string;
  config: EvalConfig;
  log?: (message: string) => void;
}): Promise<EvalRunResult> {
  const log = options.log ?? (() => undefined);
  const { config } = options;
  const cases = await loadCases(options.goldenDir);
  const extract = new ExtractStage(options.gateway);
  const verify = new VerifyStage(options.gateway);
  const referenceTime = new Date(config.reference_time);

  const byLang = new Map<string, EvalMetrics>();
  const aggregate = emptyMetrics('aggregate');

  for (const testCase of cases) {
    const metrics = byLang.get(testCase.lang) ?? emptyMetrics(testCase.lang);
    byLang.set(testCase.lang, metrics);

    // Per-case anchor when the case pins one (F8 date cases); else the global
    // reference time.
    const caseAnchor = testCase.expected.source_date
      ? new Date(testCase.expected.source_date)
      : referenceTime;
    const source: SourceItem = {
      sourceType: 'user_note',
      sourceId: `golden-${testCase.caseId}`,
      ownerId: 'golden-eval',
      content: testCase.source,
      createdAt: caseAnchor,
    };
    const chunks = chunkContent(source.content);
    let facts: CandidateFact[];
    let verified;
    try {
      facts = await extract.run(source, chunks);
      verified = await verify.run(chunks, facts);
    } catch (error) {
      // A hard model failure on one case must not abort the whole run; the
      // case scores as extracted-nothing (full recall penalty) and is flagged.
      log(`${testCase.caseId}: CASE FAILED (${error instanceof Error ? error.message : error})`);
      const mustExtract = testCase.expected.expected_memories.filter((l) => l.must_extract).length;
      metrics.cases += 1;
      metrics.mustExtractLabels += mustExtract;
      aggregate.cases += 1;
      aggregate.mustExtractLabels += mustExtract;
      continue;
    }

    // Semantic matching: greedy best-similarity assignment, expected → fact.
    const labels = testCase.expected.expected_memories;
    const embeddings =
      facts.length + labels.length > 0
        ? await options.gateway.embed([
            ...facts.map((fact) => fact.claim),
            ...labels.map((label) => label.content_gist),
          ])
        : [];
    const factVecs = embeddings.slice(0, facts.length);
    const labelVecs = embeddings.slice(facts.length);

    const factMatched = new Array<boolean>(facts.length).fill(false);
    let matchedMustExtract = 0;
    for (let li = 0; li < labels.length; li++) {
      const label = labels[li]!;
      let best = -1;
      let bestSim = 0;
      for (let fi = 0; fi < facts.length; fi++) {
        if (factMatched[fi]) continue;
        const sim = cosine(factVecs[fi]!, labelVecs[li]!);
        if (
          sim >= config.similarity_threshold &&
          entityOverlap(label.entities, facts[fi]!) >= config.entity_overlap_threshold &&
          sim > bestSim
        ) {
          best = fi;
          bestSim = sim;
        }
      }
      if (best >= 0) {
        factMatched[best] = true;
        if (label.must_extract) matchedMustExtract += 1;
      }
    }

    const matchedExtracted = factMatched.filter(Boolean).length;
    const mustExtract = labels.filter((label) => label.must_extract).length;

    metrics.cases += 1;
    metrics.extractedFacts += facts.length;
    metrics.matchedExtracted += matchedExtracted;
    metrics.mustExtractLabels += mustExtract;
    metrics.matchedMustExtract += matchedMustExtract;

    // Verification agreement (rule documented in the header).
    const expectedVerdict = testCase.expected.verification_expected;
    let agreed: boolean | null = null;
    if (expectedVerdict === 'unsupported') {
      const straySupported = verified.filter(
        (v, i) => !factMatched[i] && v.verdict === 'supported',
      );
      agreed = straySupported.length === 0;
    } else if (expectedVerdict) {
      const matchedVerdicts = verified.filter((_, i) => factMatched[i]);
      agreed =
        matchedVerdicts.length > 0 && matchedVerdicts.every((v) => v.verdict === expectedVerdict);
    }
    if (agreed !== null) {
      metrics.verificationCases += 1;
      aggregate.verificationCases += 1;
      if (agreed) {
        metrics.verificationAgreed += 1;
        aggregate.verificationAgreed += 1;
      }
    }

    aggregate.cases += 1;
    aggregate.extractedFacts += facts.length;
    aggregate.matchedExtracted += matchedExtracted;
    aggregate.mustExtractLabels += mustExtract;
    aggregate.matchedMustExtract += matchedMustExtract;

    log(
      `${testCase.caseId}: extracted ${facts.length}, matched ${matchedExtracted}/${labels.length} labels` +
        (agreed === null ? '' : `, verification ${agreed ? 'agrees' : 'DISAGREES'}`),
    );
  }

  return {
    perLanguage: [...byLang.values()].map(finalize).sort((a, b) => a.label.localeCompare(b.label)),
    aggregate: finalize(aggregate),
    config,
    promptVersions: `${EXTRACTION_PROMPT.family}/${EXTRACTION_PROMPT.version} + ${VERIFICATION_PROMPT.family}/${VERIFICATION_PROMPT.version}`,
    caseCount: cases.length,
  };
}
