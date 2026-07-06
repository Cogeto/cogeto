/** Worker activity DTOs (O1) — the System page's live view of the queue (§A.3). */

export interface WorkerJobDto {
  jobType: string;
  sourceType: string | null;
  sourceId: string | null;
  attempts: number;
  maxAttempts: number;
  /** When a worker locked it (running jobs only). */
  since: string | null;
  /** When it is due to run (queued/waiting jobs). */
  runAt: string | null;
  /** The last failure message, when a job is retrying after a crash. */
  lastError: string | null;
}

export interface WorkerCompletionDto {
  jobType: string;
  sourceType: string | null;
  sourceId: string | null;
  at: string;
}

/**
 * A snapshot of the queue, derived from graphile-worker's own tables + the
 * job_execution ledger. Jobs are atomic transactions, so there is no truthful
 * per-job percentage; queue depth (which visibly drains) is the real progress
 * signal, alongside what is running right now and what recently completed.
 */
export interface WorkerActivityDto {
  /** Jobs a worker is executing right now. */
  running: WorkerJobDto[];
  /** Jobs ready to run, waiting for a free worker slot. */
  queued: WorkerJobDto[];
  /** Jobs deferred to the future (retry backoff or scheduled crons). */
  waiting: WorkerJobDto[];
  /** The most recent successful completions (idempotency ledger). */
  recent: WorkerCompletionDto[];
  summary: {
    running: number;
    queued: number;
    waiting: number;
    deadLetter: number;
    completedTotal: number;
  };
}
