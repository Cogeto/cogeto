import type { ResearchRunDto } from '@cogeto/shared';

/**
 * Which research run should the chat page resume (decision 0057)? Pure so the
 * rule is unit-testable:
 *
 * - an APPROVED run whose work may still be in flight (the user left mid-parse
 *   and the worker kept going), or
 * - a CONCLUDED run whose stored answer the owner has never seen.
 *
 * Both fade after {@link RESUME_WINDOW_HOURS}: stale runs live on the Research
 * page, not in the chat. Newest first; proposed/cancelled runs never resume
 * (the gate was never taken, or was declined).
 */
export const RESUME_WINDOW_HOURS = 48;

export function pickResumeRun(runs: ResearchRunDto[], now: Date): ResearchRunDto | null {
  const cutoff = now.getTime() - RESUME_WINDOW_HOURS * 3_600_000;
  const fresh = (iso: string | null) => iso !== null && new Date(iso).getTime() >= cutoff;
  const candidates = runs.filter(
    (run) =>
      (run.status === 'approved' && fresh(run.approvedAt)) ||
      (run.status === 'concluded' && run.answerSeenAt === null && fresh(run.concludedAt)),
  );
  if (candidates.length === 0) return null;
  const at = (run: ResearchRunDto) =>
    new Date(run.concludedAt ?? run.approvedAt ?? run.createdAt).getTime();
  return candidates.sort((a, b) => at(b) - at(a))[0] ?? null;
}
