/** Response shape of GET /api/health — the dashboard system-status panel. */
export interface HealthCheck {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  checks: {
    postgres: HealthCheck;
    qdrant: HealthCheck;
    minio: HealthCheck;
  };
}
