import type { ResearchRunDto } from '@cogeto/shared';

/**
 * Which research run should the chat page resume? Pure
 * so the rule is unit-testable. ONLY an APPROVED run still in flight resumes
 * — to show live progress. Concluded runs never resume: their answer is a
 * persistent message in the conversation, or, for Research-page
 * runs, lives there. Seen runs never resume whatever their status (#257 —
 * no acknowledged run may haunt the chat), and everything fades after
 * {@link RESUME_WINDOW_HOURS}.
 */
export const RESUME_WINDOW_HOURS = 48;

export function pickResumeRun(runs: ResearchRunDto[], now: Date): ResearchRunDto | null {
  const cutoff = now.getTime() - RESUME_WINDOW_HOURS * 3_600_000;
  const fresh = (iso: string | null) => iso !== null && new Date(iso).getTime() >= cutoff;
  const candidates = runs.filter(
    (run) => run.answerSeenAt === null && run.status === 'approved' && fresh(run.approvedAt),
  );
  if (candidates.length === 0) return null;
  const at = (run: ResearchRunDto) => new Date(run.approvedAt ?? run.createdAt).getTime();
  return candidates.sort((a, b) => at(b) - at(a))[0] ?? null;
}
