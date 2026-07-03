import { z } from 'zod';

/**
 * The extractor's output contract (S2-A §3) and the verifier's verdict contract
 * (§B.3). Both are Zod-validated at the gateway boundary: output that fails the
 * schema is never stored — it surfaces as a retryable job failure.
 */

export const FACT_KINDS = ['commitment', 'decision', 'preference', 'fact', 'open_loop'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

const temporalSchema = z.object({
  /** ISO date/datetime, resolved against the source timestamp; null if unresolvable. */
  valid_from: z.string().nullable(),
  valid_until: z.string().nullable(),
  /** False when the source contained relative anchors the model could not resolve. */
  anchors_resolved: z.boolean(),
});

export const candidateFactSchema = z.object({
  /** One self-contained sentence — proper nouns and qualifiers preserved. */
  claim: z.string().min(1),
  kind: z.enum(FACT_KINDS),
  entities: z.object({
    people: z.array(z.string()),
    organizations: z.array(z.string()),
    projects: z.array(z.string()),
  }),
  condition: z.string().nullable(),
  temporal: temporalSchema,
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
 * Turns the model's ISO strings into validity-interval dates. A string that
 * does not parse is treated as unresolved (null) rather than stored corrupt.
 */
export function resolveTemporal(temporal: CandidateFact['temporal']): {
  validFrom?: Date;
  validUntil?: Date;
} {
  const parse = (value: string | null): Date | undefined => {
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  };
  return { validFrom: parse(temporal.valid_from), validUntil: parse(temporal.valid_until) };
}
