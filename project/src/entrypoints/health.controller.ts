import { Controller, Get, HttpCode, Inject } from '@nestjs/common';
import type { HealthCheck, HealthReport, QueueHealthCheck } from '@cogeto/shared';
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
    const [postgres, qdrant, minio, migrations, queue] = await Promise.all([
      this.checkPostgres(),
      this.checkHttp(`${this.config.qdrantUrl}/readyz`),
      this.checkHttp(`${this.config.s3Url}/minio/health/live`),
      this.checkMigrations(),
      this.checkQueue(),
    ]);
    const checks = { postgres, qdrant, minio, migrations, queue };
    return {
      status: Object.values(checks).every((c) => c.ok) ? 'ok' : 'degraded',
      checks,
    };
  }

  /** Queue depth + dead-letter count for the System view (S3-B). */
  private async checkQueue(): Promise<QueueHealthCheck> {
    const started = Date.now();
    try {
      const [jobs, parked] = await Promise.all([
        this.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM graphile_worker.jobs'),
        this.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM dead_letter'),
      ]);
      const depth = Number(jobs.rows[0]?.n ?? 0);
      const deadLettered = Number(parked.rows[0]?.n ?? 0);
      return {
        // Parked jobs mean work was lost until someone retries — surface it.
        ok: deadLettered === 0,
        latencyMs: Date.now() - started,
        depth,
        deadLettered,
        detail: `${depth} queued, ${deadLettered} dead-lettered`,
        ...(deadLettered > 0 ? { error: `${deadLettered} dead-lettered job(s)` } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        depth: 0,
        deadLettered: 0,
        error: message(error),
      };
    }
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

  private async checkMigrations(): Promise<HealthCheck> {
    const started = Date.now();
    try {
      const { rows } = await this.pool.query<{ name: string }>(
        'SELECT name FROM cogeto_migrations ORDER BY id',
      );
      const latest = rows[rows.length - 1]?.name;
      return {
        ok: rows.length >= 2,
        latencyMs: Date.now() - started,
        detail: latest ? `${rows.length} applied, latest ${latest}` : 'none applied',
        ...(rows.length >= 2 ? {} : { error: 'contractual core (0001/0002) not applied' }),
      };
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
