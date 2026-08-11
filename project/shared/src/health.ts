/** Response shape of GET /api/health — the dashboard system-status panel. */
export interface HealthCheck {
  ok: boolean;
  latencyMs: number;
  error?: string;
  /** Optional human-readable extra, e.g. "2 migrations applied". */
  detail?: string;
}

/** Queue visibility for the System view: depth + dead-letter count. */
export interface QueueHealthCheck extends HealthCheck {
  depth: number;
  deadLettered: number;
  /**
   * Graphile jobs that exhausted their retries and will NOT run again
   * (attempts ≥ max_attempts, last_error set) —. Unlike dead_letter (our
   * own parked-work table), these still sit in the queue as permanent failures;
   * any > 0 degrades the instance so an operator is alerted.
   */
  permanentlyFailed: number;
}

/**
 * Optional-capability visibility. Every optional
 * capability of the instance reports one of three states; "unreachable" is the
 * LOUD state (enabled but not actually working) and degrades /api/health.
 */
export type CapabilityId =
  | 'redaction'
  | 'research'
  | 'mail'
  // Inbound email capture (audit 2.0 SEC-14). Behind the `mail` compose
  // profile, so an instance that does not use it runs no SMTP listener.
  | 'demo'
  | 'consoles'
  | 'local-models'
  // Reading pages that are pictures (V2.1 item 4.1). Probed by sending a real
  // image: the same weights are served with and without a multimodal
  // projector, so nothing short of an image can answer the question.
  | 'vision'
  // The generation model returns its thinking in a separate reasoning field
  // (Part B of reasoning support). Probed by sending a real prompt, for the
  // same reason vision is probed: the same weights are served both ways. On
  // means maxTokens headroom is applied so reasoning cannot silently consume
  // an answer's token budget; off is a complete, healthy answer.
  | 'reasoning'
  // The connector fleet (V2.5 item 8.1): off when none is configured, on
  // while every configured connector is healthy, LOUD when any is degraded
  // or needs reauthorisation, with the actionable fix in the message.
  | 'connectors';

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

/** The rebuild as the health report carries it — the same shape the Models
 * page polls, minus nothing: one source row feeds every surface. */
export interface EmbeddingRebuildHealth {
  status: 'running' | 'failed';
  phase: 'embedding' | 'finalizing';
  targetModel: string;
  factsDone: number;
  factsTotal: number;
  startedAt: string | null;
  estimatedSecondsRemaining: number | null;
  error?: string;
}

/** Scheduled jobs join the same surface: last run + overdue. */
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
  /** Optional-capability registry states — additive; loud states degrade. */
  capabilities: CapabilitySummary[];
  /** Scheduled-job states (dreaming, sweep) — additive; overdue/failing degrade. */
  jobs: ScheduledJobSummary[];
  /**
   * The managed embedding rebuild in flight, when there is one (V2.4 item
   * 7.1 second half) — additive, so an operator watching the instance sees
   * what it is doing. A RUNNING rebuild is healthy work, never a degradation;
   * a FAILED one degrades, because it sits waiting for a human verb.
   */
  reindex?: EmbeddingRebuildHealth | null;
  checks: {
    postgres: HealthCheck;
    qdrant: HealthCheck;
    minio: HealthCheck;
    /** Bucket default encryption reported by MinIO. */
    minioEncryption: HealthCheck;
    /** Nightly sweep result: open integrity alerts + chain status (spec §11.1 step 4). */
    integrity: HealthCheck;
    migrations: HealthCheck;
    queue: QueueHealthCheck;
    /** Model-gateway reachability probe — cheap, cached. */
    gateway: HealthCheck;
    /**
     * Inbound mail: the per-tenant Haraka SMTP listener is
     * accepting connections. `ok` with a "not configured" detail when the
     * instance runs without the mail service (COGETO_MAIL_SMTP_ADDRESS unset).
     */
    mail: HealthCheck;
  };
}
