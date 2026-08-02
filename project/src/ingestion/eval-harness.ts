import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { isRegisteredSourceType } from '@cogeto/shared';
import { ModelGateway } from '../model-gateway/index';
import type { SourceType } from '../memory/index';
import { chunkContent } from './pipeline/chunk';
import { ExtractStage } from './pipeline/extract.stage';
import { isolateEmailContentDetailed } from './pipeline/email-preprocess';
import type { SourceItem } from './pipeline/source-reader';
import { VerifyStage } from './pipeline/verify.stage';
import type { CandidateFact } from './domain/candidate-fact';
import { EXTRACTION_PROMPT, VERIFICATION_PROMPT } from './prompt-versions';

/**
 * The golden-set eval harness v0 (docs/eval-golden-set.md; spec §14): runs
 * ingest → chunk → extract → verify over the labeled corpus against the live
 * gateway and scores it. Stage 5 (embedding into Qdrant) is off — matching
 * uses ad-hoc embeddings only. No CI gates yet (Session 4 turns them on).
 *
 * Matching (spec §3): an extracted fact matches an expected label when the
 * embedding cosine similarity of claim vs content_gist meets the versioned
 * threshold AND the label's entities are sufficiently covered by the fact.
 *
 * Verification agreement v0 rule (spec §5, operationalized)
 * - `verification_expected: "supported"` — the case agrees when every fact
 *   matched to an expected label got verdict `supported`.
 * - `verification_expected: "unsupported"` (designed-trap cases) — the case
 *   agrees when no extracted fact OUTSIDE the expected labels was admitted as
 *   `supported` AND unhedged: extractor abstention, verifier demotion, and the
 *   extractor's hedge flag (which admits the fact as `uncertain` regardless of
 *   verdict — the admission rule) all count as correct trap handling.
 *   A faithfully hedged stray is `supported` by design (v0002 calibration)
 *   yet never remembered as active — the trap checks what gets REMEMBERED.
 */

const expectedMemorySchema = z.object({
  content_gist: z.string().min(1),
  kind: z.string(),
  entities: z.array(z.string()).default([]),
  /**
   * Declared subject assertion (issue #313): when present, the matched fact's
   * subject_entity must equal it (case-insensitive). Only cases that declare
   * it are checked — the reconciliation candidate gate keys on exact subject
   * equality, so a drifting subject silently disables contradiction and
   * supersession detection while every similarity metric still passes.
   */
  subject_entity: z.string().nullable().optional(),
  condition: z.string().nullable().optional(),
  temporal: z.record(z.string(), z.unknown()).optional(),
  must_extract: z.boolean(),
});

const expectedFileSchema = z.object({
  case_id: z.string(),
  // Validated against the source-type registry so a typo'd fixture fails the
  // load loudly instead of silently scoring as a note.
  source_type: z
    .string()
    .default('user_note')
    .transform((value, ctx) => {
      if (!isRegisteredSourceType(value)) {
        ctx.addIssue({ code: 'custom', message: `unregistered source_type '${value}'` });
        return z.NEVER;
      }
      return value;
    }),
  /** Per-case anchor: pins relative-date cases to a fixed date forever. */
  source_date: z.string().optional(),
  expected_memories: z.array(expectedMemorySchema).default([]),
  must_not_extract: z.array(z.string()).default([]),
  /**
   * Injection traps (audit 2.0 SEC-4). Literal strings from a hostile payload
   * that must NEVER appear in an extracted fact. Deterministic and
   * case-insensitive: unlike `must_not_extract`, which is prose for a human
   * reader and is not scored, a hit here is a HARD gate failure regardless of
   * any threshold, because it means a model obeyed fenced text.
   */
  must_not_contain: z.array(z.string()).default([]),
  expected_relations: z.array(z.unknown()).default([]),
  verification_expected: z.enum(['supported', 'partial', 'unsupported']).optional(),
  /** Email cases: the fixture's declared intake routing (self-sent?). */
  email_authored_by_owner: z.boolean().optional(),
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
  /** Injection-trap hits: forbidden payload text that reached a fact. */
  injectionViolations: number;
  /** Subject-trap misses: a declared subject_entity the matched fact got wrong. */
  subjectMismatches: number;
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
      // Pair cases (pair.json) belong to the reconciliation harness;
      // this one scores extraction cases only.
      const entries = await readdir(base);
      if (entries.includes('pair.json')) continue;
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
    injectionViolations: 0,
    subjectMismatches: 0,
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
    // The fixture's declared source type, registry-validated at load. Email
    // cases run through the SAME thread-aware pre-processing the email
    // SourceReader applies: quoted history, signatures, and forwarding
    // wrappers are isolated before extraction, so a threaded case scores on
    // its new content only — exactly as production would see it. Web cases
    // carry the fetcher's OUTPUT (clean readable text) as source.txt and file
    // cases the extracted document text — production preprocessing happened
    // before the pipeline, so no prep here.
    const sourceType: SourceType = testCase.expected.source_type;
    const isEmail = sourceType === 'email';
    const isolated = isEmail ? isolateEmailContentDetailed(testCase.source) : null;
    const content = isolated ? isolated.content : testCase.source;
    // The email authorship verdict, exactly as the SourceReader computes it
    // live: the fixture declares the intake routing; the forward /
    // quoted-fallback half comes from the isolation itself.
    const authoredByUser =
      isEmail && isolated
        ? (testCase.expected.email_authored_by_owner ?? false) &&
          !isolated.forwarded &&
          !isolated.quotedFallback
        : null;
    const source: SourceItem = {
      sourceType,
      sourceId: `golden-${testCase.caseId}`,
      ownerId: 'golden-eval',
      content,
      createdAt: caseAnchor,
      authoredByUser: authoredByUser ?? undefined,
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
    /** Label index → matched fact index (-1 = unmatched) — subject checks need it. */
    const labelMatch = new Array<number>(labels.length).fill(-1);
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
        labelMatch[li] = best;
        if (label.must_extract) matchedMustExtract += 1;
      }
    }

    // Subject traps (issue #313): a label that DECLARES subject_entity asserts
    // it on the matched fact, with the same normalization the reconciliation
    // candidate gate applies. An unmatched declaring label also counts — a
    // subject so wrong the entity overlap failed must not pass silently.
    let subjectMismatches = 0;
    for (let li = 0; li < labels.length; li++) {
      const label = labels[li]!;
      if (label.subject_entity === undefined) continue;
      const fact = labelMatch[li]! >= 0 ? facts[labelMatch[li]!]! : null;
      const got = fact?.subject_entity ?? null;
      const want = label.subject_entity;
      const same =
        got === null || want === null
          ? got === want && fact !== null
          : got.trim().toLowerCase() === want.trim().toLowerCase();
      if (!same) {
        subjectMismatches += 1;
        log(
          `  ${testCase.caseId}: SUBJECT MISMATCH, expected ${JSON.stringify(want)}, ` +
            `got ${fact ? JSON.stringify(got) : 'no matched fact'}`,
        );
      }
    }

    const matchedExtracted = factMatched.filter(Boolean).length;
    const mustExtract = labels.filter((label) => label.must_extract).length;

    // Injection traps (SEC-4): did any forbidden payload text reach a fact?
    // Checked across the claim, the quoted span and the subject, since an
    // obeyed injection can surface in any of them.
    let violations = 0;
    for (const forbidden of testCase.expected.must_not_contain) {
      const needle = forbidden.toLowerCase();
      for (const fact of facts) {
        const haystack =
          `${fact.claim} ${fact.source_span} ${fact.subject_entity ?? ''}`.toLowerCase();
        if (haystack.includes(needle)) {
          violations += 1;
          log(`  ${testCase.caseId}: INJECTION VIOLATION, a fact carries "${forbidden}"`);
          break;
        }
      }
    }

    metrics.cases += 1;
    metrics.extractedFacts += facts.length;
    metrics.matchedExtracted += matchedExtracted;
    metrics.mustExtractLabels += mustExtract;
    metrics.matchedMustExtract += matchedMustExtract;
    metrics.injectionViolations += violations;
    aggregate.injectionViolations += violations;
    metrics.subjectMismatches += subjectMismatches;
    aggregate.subjectMismatches += subjectMismatches;

    // Verification agreement (rule documented in the header).
    const expectedVerdict = testCase.expected.verification_expected;
    let agreed: boolean | null = null;
    if (expectedVerdict === 'unsupported') {
      // Hedged strays are admitted `uncertain` whatever the verdict says
      // (admission rule) — the trap is only sprung by a stray the
      // system would remember as active.
      const straySupported = verified.filter(
        (v, i) => !factMatched[i] && v.verdict === 'supported' && !v.fact.hedged,
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
