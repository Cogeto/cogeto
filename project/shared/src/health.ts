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
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  checks: {
    postgres: HealthCheck;
    qdrant: HealthCheck;
    minio: HealthCheck;
    migrations: HealthCheck;
    queue: QueueHealthCheck;
  };
}
