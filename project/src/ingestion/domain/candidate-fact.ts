import { z } from 'zod';
import { FACT_KINDS } from '@cogeto/shared';
import { resolveTemporalExpressions } from './temporal-resolver';
import type { ResolvedInterval } from './temporal-resolver';

/**
 * The extractor's output contract (S2-A §3) and the verifier's verdict contract
 * (§B.3). Both are Zod-validated at the gateway boundary: output that fails the
 * schema is never stored — it surfaces as a retryable job failure.
 *
 * FACT_KINDS lives in @cogeto/shared since F2-A: the memory table stores kind
 * (migration 0011) and the two must never drift.
 */

export { FACT_KINDS } from '@cogeto/shared';
export type { FactKind } from '@cogeto/shared';

// Absent-but-unambiguous fields default instead of failing the schema: a
// missing entity array means "none", a missing condition means "none" — models
// routinely omit empties, and rejecting the whole extraction for that is a
// spurious retry. claim/kind/source_span stay strict.
const temporalSchema = z.object({
  /** ISO date/datetime, resolved against the source timestamp; null if unresolvable. */
  valid_from: z.string().nullable().default(null),
  valid_until: z.string().nullable().default(null),
  /** False when the source contained relative anchors the model could not resolve. */
  anchors_resolved: z.boolean().default(true),
});

/**
 * New temporal contract (decision 0007 ruling 1): the extractor emits raw
 * expressions and code resolves them. v0001 emits none (defaults to []), so the
 * old resolved `temporal` fields still drive dates until v0002 ships in
 * S3.5-B — nothing breaks mid-session.
 */
export const temporalExpressionSchema = z.object({
  /** The source phrase verbatim, e.g. "by Monday". */
  raw: z.string().min(1),
  kind: z.enum(['valid_from', 'valid_until', 'point']).default('point'),
});

export const candidateFactSchema = z.object({
  /** One self-contained sentence — proper nouns and qualifiers preserved. */
  claim: z.string().min(1),
  kind: z.enum(FACT_KINDS),
  entities: z
    .object({
      people: z.array(z.string()).default([]),
      organizations: z.array(z.string()).default([]),
      projects: z.array(z.string()).default([]),
    })
    .default({ people: [], organizations: [], projects: [] }),
  condition: z.string().nullable().default(null),
  temporal: temporalSchema.default({ valid_from: null, valid_until: null, anchors_resolved: true }),
  /** Raw temporal expressions, resolved by code against the note anchor (v0002+). */
  temporal_expressions: z.array(temporalExpressionSchema).default([]),
  /**
   * Hedge detection (v0002, F7): true when the SOURCE states the claim
   * tentatively (may/might/possibly/conditional preference wording). A hedged
   * fact is admitted `uncertain` even if the verifier supports it — the hedge
   * is the extractor's dimension, not the verifier's. v0001 omits → false.
   */
  hedged: z.boolean().default(false),
  /** The tentative phrase that set `hedged`, verbatim; null when not hedged. */
  hedge_phrase: z.string().nullable().default(null),
  /**
   * The person or organization the fact is primarily ABOUT (v0002, F1/F4),
   * distinct from other mentioned entities — the Marta-inclusion note's subject
   * is Ana. v0001 omits → null.
   */
  subject_entity: z.string().nullable().default(null),
  /** The exact substring of the source that motivated this fact. */
  source_span: z.string().min(1),
});

/** Calibrated abstention (§3): a source with nothing durable yields facts: []. */
export const extractionOutputSchema = z.object({
  facts: z.array(candidateFactSchema),
});

export type CandidateFact = z.infer<typeof candidateFactSchema>;

export const VERIFICATION_VERDICTS = ['supported', 'partial', 'unsupported'] as const;

export const verificationOutputSchema = z.object({
  verdict: z.enum(VERIFICATION_VERDICTS),
  reason: z.string().min(1),
});

export type VerificationOutput = z.infer<typeof verificationOutputSchema>;

/**
 * Resolve a fact's validity interval against the note anchor (§A.6, decision
 * 0007 ruling 1). Accepts BOTH contracts so nothing breaks mid-session:
 * - new form: `temporal_expressions` are resolved deterministically by code;
 * - old form (v0001): already-resolved ISO strings pass through unchanged.
 * The new form wins when present.
 */
export function resolveFactTemporal(fact: CandidateFact, anchor: Date): ResolvedInterval {
  if (fact.temporal_expressions.length > 0) {
    return resolveTemporalExpressions(fact.temporal_expressions, anchor);
  }
  const parse = (value: string | null): Date | undefined => {
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  };
  return {
    validFrom: parse(fact.temporal.valid_from),
    validUntil: parse(fact.temporal.valid_until),
    unresolved: [],
  };
}
