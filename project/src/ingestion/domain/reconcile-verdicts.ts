import { z } from 'zod';

/**
 * Output contracts of the two reconciliation prompt families (decision 0010;
 * §B.7). Zod-validated at the gateway boundary: output that fails the schema
 * is a retryable job failure, never an action.
 *
 * Conservatism is structural, not just prompted: anything other than an exact
 * `same_fact` / `contradicts` / well-formed `supersedes` results in NO action.
 */

export const DEDUP_VERDICTS = ['same_fact', 'distinct', 'related'] as const;

export const dedupVerdictSchema = z.object({
  verdict: z.enum(DEDUP_VERDICTS),
  reason: z.string().min(1),
  /**
   * Only meaningful with `same_fact`: the survivor's claim enriched with a
   * concrete detail only the other fact carried; null unless that detail
   * exists (the prompt biases hard to null). Ignored for other verdicts.
   */
  merged_content: z.string().nullable().default(null),
});
export type DedupVerdict = z.infer<typeof dedupVerdictSchema>;

export const CONTRADICTION_VERDICTS = ['contradicts', 'compatible', 'supersedes'] as const;

export const contradictionVerdictSchema = z.object({
  verdict: z.enum(CONTRADICTION_VERDICTS),
  /**
   * Required in substance when verdict is `supersedes`; a missing direction is
   * treated as ambiguous and routes to contradiction (0010 ruling 7) rather
   * than failing the schema — conservatism over retries.
   */
  direction: z.enum(['a_over_b', 'b_over_a']).nullable().default(null),
  reason: z.string().min(1),
});
export type ContradictionVerdict = z.infer<typeof contradictionVerdictSchema>;
