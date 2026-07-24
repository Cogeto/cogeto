/** Response shape of GET /api/health — the dashboard system-status panel. */
export interface HealthCheck {
  ok: boolean;
  latencyMs: number;
  error?: string;
  /** Optional human-readable extra, e.g. "2 migrations applied". */
  detail?: string;
}

/** Queue visibility for the System view (S3-B): depth + dead-letter count. */
export interface QueueHealthCheck extends HealthCheck {
  depth: number;
  deadLettered: number;
  /**
   * Graphile jobs that exhausted their retries and will NOT run again
   * (attempts ≥ max_attempts, last_error set) — QS-34. Unlike dead_letter (our
   * own parked-work table), these still sit in the queue as permanent failures;
   * any > 0 degrades the instance so an operator is alerted.
   */
  permanentlyFailed: number;
}

/**
 * Optional-capability visibility (P6.7, decision 0055). Every optional
 * capability of the instance reports one of three states; "unreachable" is the
 * LOUD state (enabled but not actually working) and degrades /api/health.
 */
export type CapabilityId = 'redaction' | 'research' | 'demo' | 'consoles' | 'local-models';

export type CapabilityState = 'on' | 'unreachable' | 'off';

export interface CapabilitySummary {
  id: CapabilityId;
  state: CapabilityState;
  /** True when the state came from an active probe; false for passive signals
   * (config flags, the production guard) that have nothing to probe. */
  probed: boolean;
  /** When this state was assembled (registry snapshots are cached ~20 s). */
  checkedAt: string;
  detail?: string;
  /** Set on the loud state: what is broken, in operator terms. */
  error?: string;
}

/** Scheduled jobs join the same surface (decision 0055): last run + overdue. */
export type ScheduledJobId = 'dreaming' | 'sweep';

export type ScheduledJobState = 'ok' | 'overdue' | 'failing';

export interface ScheduledJobSummary {
  id: ScheduledJobId;
  state: ScheduledJobState;
  /** Last SUCCESSFUL run; null when the job has never completed. */
  lastRunAt: string | null;
  /** One-line summary of the last successful run's result. */
  lastResult: string | null;
  /** The frozen overdue threshold in hours (COGETO_JOBS_OVERDUE_HOURS). */
  overdueAfterHours: number;
  checkedAt: string;
  error?: string;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  /** Optional-capability registry states (P6.7) — additive; loud states degrade. */
  capabilities: CapabilitySummary[];
  /** Scheduled-job states (dreaming, sweep) — additive; overdue/failing degrade. */
  jobs: ScheduledJobSummary[];
  checks: {
    postgres: HealthCheck;
    qdrant: HealthCheck;
    minio: HealthCheck;
    /** Bucket default encryption reported by MinIO (§A.9, decision 0008). */
    minioEncryption: HealthCheck;
    /** Nightly sweep result: open integrity alerts + chain status (§A.7 step 4). */
    integrity: HealthCheck;
    migrations: HealthCheck;
    queue: QueueHealthCheck;
    /** Model-gateway reachability probe — cheap, cached (QS-35). */
    gateway: HealthCheck;
    /**
     * Inbound mail (Session O4): the per-tenant Haraka SMTP listener is
     * accepting connections. `ok` with a "not configured" detail when the
     * instance runs without the mail service (COGETO_MAIL_SMTP_ADDRESS unset).
     */
    mail: HealthCheck;
  };
}
