import { Controller, Get, HttpCode, Inject } from '@nestjs/common';
import type { HealthCheck, HealthReport, QueueHealthCheck } from '@cogeto/shared';
import { Pool } from 'pg';
import { IntegritySweep, MemoryObjectStore } from '../memory/index';
import { ModelGateway } from '../model-gateway/index';
import { Public } from '../identity/index';
import { COGETO_CONFIG } from './config';
import type { CogetoConfig } from './config';

/**
 * GET /api/health — aggregate reachability of Postgres, Qdrant, MinIO for the
 * dashboard status panel. GET /api/health/live — container liveness only.
 * Lives in the entrypoint (deployment concern, not domain). Public (QS-18):
 * liveness/readiness must answer without a token.
 */
@Public()
@Controller('health')
export class HealthController {
  private readonly pool: Pool;

  constructor(
    @Inject(COGETO_CONFIG) private readonly config: CogetoConfig,
    private readonly objects: MemoryObjectStore,
    private readonly integrity: IntegritySweep,
    private readonly gateway: ModelGateway,
  ) {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  }

  @Get('live')
  @HttpCode(200)
  live(): { alive: true } {
    return { alive: true };
  }

  @Get()
  async health(): Promise<HealthReport> {
    const [postgres, qdrant, minio, minioEncryption, integrity, migrations, queue, gateway] =
      await Promise.all([
        this.checkPostgres(),
        this.checkHttp(`${this.config.qdrantUrl}/readyz`),
        this.checkHttp(`${this.config.s3Url}/minio/health/live`),
        this.checkBucketEncryption(),
        this.checkIntegrity(),
        this.checkMigrations(),
        this.checkQueue(),
        this.checkGateway(),
      ]);
    const checks = {
      postgres,
      qdrant,
      minio,
      minioEncryption,
      integrity,
      migrations,
      queue,
      gateway,
    };
    return {
      status: Object.values(checks).every((c) => c.ok) ? 'ok' : 'degraded',
      checks,
    };
  }

  /**
   * The bucket must REPORT default encryption enabled (§A.9, audit 3.9) —
   * minio-init asserts it once at compose up; this keeps asserting it for the
   * instance's lifetime. A bucket storing plaintext bytes degrades the stack.
   */
  private async checkBucketEncryption(): Promise<HealthCheck> {
    const started = Date.now();
    try {
      const enabled = await this.objects.encryptionEnabled();
      return {
        ok: enabled,
        latencyMs: Date.now() - started,
        ...(enabled
          ? { detail: 'SSE-S3 default encryption on' }
          : { error: 'bucket reports NO default encryption (see decision 0008)' }),
      };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: message(error) };
    }
  }

  /** Queue depth + dead-letter + graphile permanent-failure count (S3-B, QS-34). */
  private async checkQueue(): Promise<QueueHealthCheck> {
    const started = Date.now();
    try {
      const [jobs, parked, failed] = await Promise.all([
        this.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM graphile_worker.jobs'),
        this.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM dead_letter'),
        // QS-34: jobs that exhausted their retries and will not run again. Our
        // dead_letter write is best-effort under DB pressure (queue.ts retries),
        // so surfacing graphile's own permanent-failure count is the backstop
        // alert — a parked job that never made it into dead_letter still shows.
        this.pool.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM graphile_worker.jobs WHERE attempts >= max_attempts AND last_error IS NOT NULL',
        ),
      ]);
      const depth = Number(jobs.rows[0]?.n ?? 0);
      const deadLettered = Number(parked.rows[0]?.n ?? 0);
      const permanentlyFailed = Number(failed.rows[0]?.n ?? 0);
      const problems: string[] = [];
      if (deadLettered > 0) problems.push(`${deadLettered} dead-lettered job(s)`);
      if (permanentlyFailed > 0) problems.push(`${permanentlyFailed} permanently-failed job(s)`);
      return {
        // Parked or permanently-failed jobs mean work was lost — surface both.
        ok: deadLettered === 0 && permanentlyFailed === 0,
        latencyMs: Date.now() - started,
        depth,
        deadLettered,
        permanentlyFailed,
        detail: `${depth} queued, ${deadLettered} dead-lettered, ${permanentlyFailed} permanently failed`,
        ...(problems.length > 0 ? { error: problems.join('; ') } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        depth: 0,
        deadLettered: 0,
        permanentlyFailed: 0,
        error: message(error),
      };
    }
  }

  /**
   * Model-gateway reachability (QS-35) — cheap and cached in the gateway (≤1
   * provider probe per 30s), so a dashboard poll never hammers Mistral. An
   * unconfigured gateway reports ok (model features are simply off).
   */
  private async checkGateway(): Promise<HealthCheck> {
    const started = Date.now();
    try {
      const r = await this.gateway.reachable();
      return {
        ok: r.ok,
        latencyMs: Date.now() - started,
        ...(r.detail ? { detail: r.detail } : {}),
        ...(r.error ? { error: r.error } : {}),
      };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: message(error) };
    }
  }

  /**
   * The sweep's verdict (§A.7 step 4): any open integrity alert or a broken
   * chain degrades the instance — provable forgetting is the product.
   * DB-only reads; the sweep itself runs nightly (cron) or on demand.
   */
  private async checkIntegrity(): Promise<HealthCheck> {
    const started = Date.now();
    try {
      const status = await this.integrity.status();
      const chainOk = status.lastReport?.chainOk ?? true;
      const ok = status.openAlerts === 0 && chainOk;
      const lastRun = status.lastSweepAt
        ? `last sweep ${status.lastSweepAt}`
        : 'sweep has not run yet';
      return {
        ok,
        latencyMs: Date.now() - started,
        detail: `${lastRun}; ${status.openAlerts} alert(s)`,
        ...(ok
          ? {}
          : {
              error: chainOk
                ? `${status.openAlerts} integrity alert(s) on record`
                : `receipt chain broken: ${status.lastReport?.chainError ?? 'unknown'}`,
            }),
      };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: message(error) };
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
