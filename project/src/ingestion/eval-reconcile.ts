import { readdir, readFile, access } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { FACT_KINDS } from '@cogeto/shared';
import { supersessionUnambiguous } from '../memory/index';
import { ModelGateway } from '../model-gateway/index';
import { ReconcileJudge } from './pipeline/reconcile.stage';
import type { ReconcileFactView } from './pipeline/reconcile.stage';
import { isContradictionCandidate, isDedupCandidate } from './domain/reconcile-candidates';
import { RECONCILE_CONFIG_VERSION } from './reconcile-config';

/**
 * Reconciliation pair-case eval (decision 0010 ruling 9; docs/eval-golden-set.md
 * §5–§6): runs the REAL decision path — the versioned candidate rules plus the
 * live model confirmation through ReconcileJudge — over labeled pairs under
 * project/eval/golden/{lang}/{case-dir}/pair.json, and scores ACTIONS, not
 * verdict strings:
 *
 * - dedup accuracy, weighted: must-not-merge trap pairs count double (a false
 *   merge destroys a distinct fact — spec §5);
 * - contradiction precision and recall; supersedes correctness (verdict AND
 *   direction) reported separately.
 */

const pairFactSchema = z.object({
  content: z.string().min(1),
  kind: z.enum(FACT_KINDS),
  entities: z.array(z.string()).default([]),
  subject_entity: z.string().nullable().default(null),
  captured_at: z.string(),
  valid_from: z.string().nullable().default(null),
  valid_until: z.string().nullable().default(null),
  /** Source passage shown to the judge, mirroring the pipeline's spans. */
  source: z.string().nullable().default(null),
});

export const pairCaseSchema = z.object({
  case_id: z.string(),
  task: z.enum(['dedup', 'contradiction']),
  expected: z.enum([
    'same_fact',
    'distinct',
    'contradicts',
    'compatible',
    'supersedes_a_over_b',
    'supersedes_b_over_a',
  ]),
  /** a = the more recently recorded fact (mirrors the relation convention). */
  a: pairFactSchema,
  b: pairFactSchema,
  notes: z.string().optional(),
});
export type PairCase = z.infer<typeof pairCaseSchema>;

/** What the decision path DID for a pair — the unit being scored. */
export type PairOutcome =
  | 'merged'
  | 'no_merge'
  | 'contradiction'
  | 'superseded_a_over_b'
  | 'superseded_b_over_a'
  | 'compatible'
  | 'not_a_candidate';

export interface ReconcileEvalMetrics {
  label: string;
  dedupPairs: number;
  dedupWeight: number;
  dedupEarned: number;
  dedupAccuracy: number;
  falseMerges: number;
  missedMerges: number;
  contradictionPairs: number;
  expectedContradictions: number;
  flaggedContradictions: number;
  correctContradictions: number;
  contradictionPrecision: number;
  contradictionRecall: number;
  supersedesPairs: number;
  supersedesCorrect: number;
  candidateMisses: number;
}

export interface ReconcileEvalResult {
  perLanguage: ReconcileEvalMetrics[];
  aggregate: ReconcileEvalMetrics;
  configVersion: number;
  pairCount: number;
  outcomes: { caseId: string; expected: string; outcome: PairOutcome }[];
}

interface LoadedPair {
  lang: string;
  pair: PairCase;
}

export async function loadPairCases(goldenDir: string): Promise<LoadedPair[]> {
  const pairs: LoadedPair[] = [];
  const langs = (await readdir(goldenDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const lang of langs) {
    const caseDirs = (await readdir(path.join(goldenDir, lang), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const dir of caseDirs) {
      const file = path.join(goldenDir, lang, dir, 'pair.json');
      try {
        await access(file);
      } catch {
        continue; // an extraction case — handled by the extraction harness
      }
      pairs.push({ lang, pair: pairCaseSchema.parse(JSON.parse(await readFile(file, 'utf8'))) });
    }
  }
  return pairs;
}

function toView(fact: z.infer<typeof pairFactSchema>): ReconcileFactView {
  return {
    content: fact.content,
    kind: fact.kind,
    entities: fact.entities,
    subjectEntity: fact.subject_entity,
    capturedAt: new Date(fact.captured_at),
    validFrom: fact.valid_from ? new Date(fact.valid_from) : null,
    validUntil: fact.valid_until ? new Date(fact.valid_until) : null,
    sourceSpan: fact.source,
  };
}

/** PolicyParty stand-ins for the direction guard; eval pairs are `active`. */
function toParty(id: string, fact: z.infer<typeof pairFactSchema>) {
  return {
    id,
    status: 'active' as const,
    createdAt: new Date(fact.captured_at),
    validFrom: fact.valid_from ? new Date(fact.valid_from) : null,
    validUntil: fact.valid_until ? new Date(fact.valid_until) : null,
  };
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

/**
 * The pair's trip through the decision path, mirroring stage 6 exactly:
 * candidate rules first (normalized similarity, same thresholds), dedup
 * confirmation, the distinct-escalation into the contradiction check, the
 * supersession direction guard.
 */
export async function judgePair(
  judge: ReconcileJudge,
  gateway: ModelGateway,
  pair: PairCase,
): Promise<PairOutcome> {
  const [vecA, vecB] = await gateway.embed([pair.a.content, pair.b.content]);
  const similarity = Math.min(1, Math.max(0, (cosine(vecA!, vecB!) + 1) / 2));
  const a = { kind: pair.a.kind, entities: pair.a.entities, subjectEntity: pair.a.subject_entity };
  const b = { kind: pair.b.kind, entities: pair.b.entities, subjectEntity: pair.b.subject_entity };
  const viewA = toView(pair.a);
  const viewB = toView(pair.b);

  let dedupJudgedDistinct = false;
  if (isDedupCandidate(similarity, a, b)) {
    const verdict = await judge.judgeDedup(viewA, viewB);
    if (verdict.verdict === 'same_fact') return 'merged';
    dedupJudgedDistinct = verdict.verdict === 'distinct';
    if (pair.task === 'dedup') return 'no_merge';
  } else if (pair.task === 'dedup') {
    return 'not_a_candidate';
  }

  if (!isContradictionCandidate(similarity, a, b, dedupJudgedDistinct)) {
    return 'not_a_candidate';
  }
  const verdict = await judge.judgeContradiction(viewA, viewB);
  if (verdict.verdict === 'compatible') return 'compatible';
  if (verdict.verdict === 'supersedes' && verdict.direction) {
    const partyA = toParty('a', pair.a);
    const partyB = toParty('b', pair.b);
    const winner = verdict.direction === 'a_over_b' ? partyA : partyB;
    const loser = verdict.direction === 'a_over_b' ? partyB : partyA;
    if (supersessionUnambiguous(winner, loser)) {
      return verdict.direction === 'a_over_b' ? 'superseded_a_over_b' : 'superseded_b_over_a';
    }
  }
  // contradicts, direction-less or guard-blocked supersedes → the human.
  return 'contradiction';
}

function emptyMetrics(label: string): ReconcileEvalMetrics {
  return {
    label,
    dedupPairs: 0,
    dedupWeight: 0,
    dedupEarned: 0,
    dedupAccuracy: 1,
    falseMerges: 0,
    missedMerges: 0,
    contradictionPairs: 0,
    expectedContradictions: 0,
    flaggedContradictions: 0,
    correctContradictions: 0,
    contradictionPrecision: 1,
    contradictionRecall: 1,
    supersedesPairs: 0,
    supersedesCorrect: 0,
    candidateMisses: 0,
  };
}

function finalize(m: ReconcileEvalMetrics): ReconcileEvalMetrics {
  m.dedupAccuracy = m.dedupWeight === 0 ? 1 : m.dedupEarned / m.dedupWeight;
  m.contradictionPrecision =
    m.flaggedContradictions === 0 ? 1 : m.correctContradictions / m.flaggedContradictions;
  m.contradictionRecall =
    m.expectedContradictions === 0 ? 1 : m.correctContradictions / m.expectedContradictions;
  return m;
}

function score(metrics: ReconcileEvalMetrics, pair: PairCase, outcome: PairOutcome): void {
  if (outcome === 'not_a_candidate') metrics.candidateMisses += 1;
  if (pair.task === 'dedup') {
    metrics.dedupPairs += 1;
    // False merges count double (spec §5): traps carry weight 2.
    const weight = pair.expected === 'distinct' ? 2 : 1;
    metrics.dedupWeight += weight;
    const merged = outcome === 'merged';
    const correct = pair.expected === 'same_fact' ? merged : !merged;
    if (correct) metrics.dedupEarned += weight;
    else if (pair.expected === 'distinct') metrics.falseMerges += 1;
    else metrics.missedMerges += 1;
    return;
  }
  metrics.contradictionPairs += 1;
  const flagged = outcome === 'contradiction';
  if (pair.expected === 'contradicts') {
    metrics.expectedContradictions += 1;
    if (flagged) {
      metrics.flaggedContradictions += 1;
      metrics.correctContradictions += 1;
    }
  } else if (pair.expected === 'compatible') {
    if (flagged) metrics.flaggedContradictions += 1; // precision miss
  } else {
    // supersedes pairs: correct = right action AND right direction; a
    // contradiction flag on them counts against precision (0010 ruling 9).
    metrics.supersedesPairs += 1;
    const expectedOutcome =
      pair.expected === 'supersedes_a_over_b' ? 'superseded_a_over_b' : 'superseded_b_over_a';
    if (outcome === expectedOutcome) metrics.supersedesCorrect += 1;
    if (flagged) metrics.flaggedContradictions += 1;
  }
}

export async function runReconcileEval(options: {
  gateway: ModelGateway;
  goldenDir: string;
  log?: (message: string) => void;
}): Promise<ReconcileEvalResult> {
  const log = options.log ?? (() => undefined);
  const pairs = await loadPairCases(options.goldenDir);
  const judge = new ReconcileJudge(options.gateway);

  const byLang = new Map<string, ReconcileEvalMetrics>();
  const aggregate = emptyMetrics('aggregate');
  const outcomes: ReconcileEvalResult['outcomes'] = [];

  for (const { lang, pair } of pairs) {
    const metrics = byLang.get(lang) ?? emptyMetrics(lang);
    byLang.set(lang, metrics);
    let outcome: PairOutcome;
    try {
      outcome = await judgePair(judge, options.gateway, pair);
    } catch (error) {
      // One failed pair must not abort the run; it scores as no action.
      log(`${pair.case_id}: PAIR FAILED (${error instanceof Error ? error.message : error})`);
      outcome = 'not_a_candidate';
    }
    score(metrics, pair, outcome);
    score(aggregate, pair, outcome);
    outcomes.push({ caseId: pair.case_id, expected: pair.expected, outcome });
    log(`${pair.case_id}: expected ${pair.expected} -> ${outcome}`);
  }

  return {
    perLanguage: [...byLang.values()].map(finalize).sort((a, b) => a.label.localeCompare(b.label)),
    aggregate: finalize(aggregate),
    configVersion: RECONCILE_CONFIG_VERSION,
    pairCount: pairs.length,
    outcomes,
  };
}
