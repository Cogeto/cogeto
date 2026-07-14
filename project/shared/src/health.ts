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

export interface HealthReport {
  status: 'ok' | 'degraded';
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
