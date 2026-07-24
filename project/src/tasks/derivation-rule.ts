/**
 * The first-person derivation rule (P6.5; decision 0054), as ONE pure
 * predicate shared by the engine (live derivation, backfill, cleanup
 * classification) and the golden-set derivation traps — so the eval gate
 * exercises the REAL rule, not a reimplementation.
 *
 * Tasks derive only from content the user authored or adopted:
 *   - user_note, chat            → first-person, derive.
 *   - email                      → ONLY the new content of a message the user
 *                                  wrote or sent (authored_by_user true);
 *                                  quoted history, forwarded originals and
 *                                  inbound senders' words never derive.
 *                                  Unknown authorship never derives.
 *   - file, web, calendar_event  → observed world, never derive.
 *   - task_conclusion            → system-derived, never derives (the 0037
 *                                  loop guard, now subsumed here).
 *
 * The rule governs task CREATION only. Observed obligations remain full
 * memories (extracted, verified, retrievable, citable, temporal), and
 * condition satisfaction / closure detection stay source-agnostic — a web
 * page or an inbound email may still settle an existing task.
 */

import type { SourceType } from '../memory/index';

/** Kinds that derive tasks (0013 ruling 2). */
export const DERIVING_KINDS = ['commitment', 'open_loop'] as const;

/** The source axis of the rule: is this memory first-person? */
export function firstPersonSource(row: {
  sourceType: SourceType;
  authoredByUser: boolean | null;
}): boolean {
  switch (row.sourceType) {
    case 'user_note':
    case 'chat':
      return true;
    case 'email':
      // Structural authorship only; NULL (unknown) resolves to no — a missed
      // task is recoverable via adoption, a phantom task corrodes trust.
      return row.authoredByUser === true;
    default:
      return false;
  }
}

// ── Golden-set derivation traps (P6.5; run by the eval entrypoint) ───────────

/** One trap case, as collected by the extraction harness. */
export interface DerivationTrapInput {
  caseId: string;
  lang: string;
  sourceType: SourceType;
  /** Email cases: the fixture's declared authorship; others: null. */
  authoredByUser: boolean | null;
  /** The hard assertion: exactly this many tasks would derive. */
  expectedTasks: number;
  /** Kinds of the facts the extractor produced for the case. */
  factKinds: (string | null)[];
}

export interface DerivationTrapResult {
  cases: number;
  failures: string[];
}

/**
 * Applies the real derivation rule to each trap case's extracted facts and
 * hard-asserts the derived-task count. Every extracted fact is admitted
 * (active or uncertain — both derive, 0013 ruling 2), so the count is exactly:
 * deriving-kind facts when the source is first-person, else zero.
 */
export function runDerivationTrapEval(inputs: DerivationTrapInput[]): DerivationTrapResult {
  const failures: string[] = [];
  for (const input of inputs) {
    const derivingFacts = input.factKinds.filter((kind) =>
      (DERIVING_KINDS as readonly string[]).includes(kind ?? ''),
    ).length;
    const derived = firstPersonSource(input) ? derivingFacts : 0;
    if (derived !== input.expectedTasks) {
      failures.push(
        `${input.caseId}: ${derived} task(s) would derive, expected exactly ${input.expectedTasks} ` +
          `(source ${input.sourceType}, ${derivingFacts} deriving-kind fact(s))`,
      );
    }
  }
  return { cases: inputs.length, failures };
}
