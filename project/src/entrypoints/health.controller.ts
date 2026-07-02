import { Controller, Get, HttpCode, Inject } from '@nestjs/common';
import type { HealthCheck, HealthReport } from '@cogeto/shared';
import { Pool } from 'pg';
import { COGETO_CONFIG } from './config';
import type { CogetoConfig } from './config';

/**
 * GET /api/health — aggregate reachability of Postgres, Qdrant, MinIO for the
 * dashboard status panel. GET /api/health/live — container liveness only.
 * Lives in the entrypoint (deployment concern, not domain).
 */
@Controller('health')
export class HealthController {
  private readonly pool: Pool;

  constructor(@Inject(COGETO_CONFIG) private readonly config: CogetoConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  }

  @Get('live')
  @HttpCode(200)
  live(): { alive: true } {
    return { alive: true };
  }

  @Get()
  async health(): Promise<HealthReport> {
    const [postgres, qdrant, minio] = await Promise.all([
      this.checkPostgres(),
      this.checkHttp(`${this.config.qdrantUrl}/readyz`),
      this.checkHttp(`${this.config.s3Url}/minio/health/live`),
    ]);
    const checks = { postgres, qdrant, minio };
    return {
      status: Object.values(checks).every((c) => c.ok) ? 'ok' : 'degraded',
      checks,
    };
  }

  private async checkPostgres(): Promise<HealthCheck> {
    const started = Date.now();
    try {
      await this.pool.query('SELECT 1');
      return { ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: message(error) };
    }
  }

  private async checkHttp(url: string): Promise<HealthCheck> {
    const started = Date.now();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      return response.ok
        ? { ok: true, latencyMs: Date.now() - started }
        : { ok: false, latencyMs: Date.now() - started, error: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: message(error) };
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
