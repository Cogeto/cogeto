import type { DreamDigestLine, Principal } from '@cogeto/shared';

/**
 * The digest's TASKS section, provided by the tasks module (F3 handoff §3:
 * "extend GET /api/dreaming/latest's panel with a TASKS section — never a
 * second digest"). The dependency direction stays tasks → ingestion: ingestion
 * OWNS this port (the digest endpoint lives here), and the tasks module
 * IMPLEMENTS it — so the ingestion digest controller never imports tasks and
 * the module graph stays acyclic (§A.1). Wired as an OPTIONAL global provider
 * (decision O2-A): present in the app process, absent in ingestion-only tests,
 * where the digest is dreaming-only.
 */
export interface DigestTaskContext {
  /** The latest FINISHED dream run's window start — the "since the last run"
   * boundary for the "newly unblocked" tasks line. Null when no run exists yet
   * (reminders still render; the unblocked line is skipped, having no anchor). */
  scopeFrom: Date | null;
}

export interface DigestTaskSectionPort {
  /**
   * The task lines for this caller, already ordered (due/overdue → newly
   * unblocked → dormant) and capped (≤ 3, overflow folded into "…and K more
   * tasks" → /tasks), each gated by the deriving memory's readability — no line
   * for what the caller cannot read (same rule as every digest line).
   */
  taskLines(principal: Principal, ctx: DigestTaskContext): Promise<DreamDigestLine[]>;
}

/** Nest injection token for the port above. Defined here (the host module) so
 * tasks imports it from ingestion — never the reverse. */
export const DIGEST_TASK_SECTION = Symbol('DIGEST_TASK_SECTION');
