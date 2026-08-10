import { connect } from 'node:net';
import { Controller, Get, HttpCode, Inject, Req, UseGuards } from '@nestjs/common';
import type {
  EmbeddingRebuildHealth,
  HealthCheck,
  HealthReport,
  QueueHealthCheck,
} from '@cogeto/shared';
import { DRIZZLE, InstanceProbes } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { embeddingRebuildStatus, IntegritySweep, MemoryObjectStore } from '../memory/index';
import { ModelGateway } from '../model-gateway/index';
import { Public } from '../identity/index';
import { CapabilitiesService } from './capabilities';
import { HealthAccessGuard, redactHealthReport } from './health-access.guard';
import type { HealthRequest } from './health-access.guard';
import { OPERATIONS_OPTIONS } from './operations.options';
import type { OperationsOptions } from './operations.options';

/**
 * GET /api/health/live — container liveness only, and the one genuinely public
 * route here: both compose healthchecks and the demo bootstrap poll it with no
 * token.
 *
 * GET /api/health — the aggregate report. NOT public any more (audit 2.0
 * SEC-3): `@Public()` used to sit on the CLASS, so the whole operational
 * picture — queue and dead-letter depths, migration state, the receipt-chain
 * verdict, internal service URLs, raw upstream error strings — answered any
 * internet caller through the edge. `HealthAccessGuard` now decides who may
 * call it and how much detail they get; the class-level `@Public()` only defers
 * the GLOBAL bearer guard to that one, which authenticates in its place.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(OPERATIONS_OPTIONS) private readonly config: OperationsOptions,
    private readonly objects: MemoryObjectStore,
    private readonly integrity: IntegritySweep,
    private readonly gateway: ModelGateway,
    private readonly capabilities: CapabilitiesService,
    /** The database-side probes, on infrastructure's own two-connection pool:
     * a saturated application pool must not make this endpoint hang. */
    private readonly probes: InstanceProbes,
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  /** Liveness: no token, no internals — just "this process is answering". */
  @Get('live')
  @HttpCode(200)
  live(): { alive: true } {
    return { alive: true };
  }

  @Get()
  @UseGuards(HealthAccessGuard)
  async health(@Req() request: HealthRequest): Promise<HealthReport> {
    const [
      postgres,
      qdrant,
      minio,
      minioEncryption,
      integrity,
      migrations,
      queue,
      gateway,
      mail,
      registry,
      reindex,
    ] = await Promise.all([
      this.checkPostgres(),
      this.checkHttp(`${this.config.qdrantUrl}/readyz`),
      this.checkHttp(`${this.config.s3Url}/minio/health/live`),
      this.checkBucketEncryption(),
      this.checkIntegrity(),
      this.checkMigrations(),
      this.checkQueue(),
      this.checkGateway(),
      this.checkMail(),
      this.capabilities.snapshot(),
      this.checkReindex(),
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
      mail,
    };
    // loud capability/job states are named degradations —
    // an enabled-but-unreachable capability or an overdue job is a broken
    // instance, not a footnote. The fields are additive; `checks` is unchanged.
    const loud = CapabilitiesService.loudness(registry);
    // A RUNNING rebuild is healthy work in progress; a FAILED one sits waiting
    // for a human verb and degrades like an overdue job (V2.4 item 7.1).
    const reindexLoud = reindex?.status === 'failed';
    const report: HealthReport = {
      status:
        Object.values(checks).every((c) => c.ok) && loud.length === 0 && !reindexLoud
          ? 'ok'
          : 'degraded',
      capabilities: registry.capabilities,
      jobs: registry.jobs,
      reindex,
      checks,
    };
    // Audience trim (SEC-3). The verdict — every `ok`/`state` and the overall
    // status — is identical for everyone, so the Dashboard's status panel keeps
    // working for a plain user; only the operational PROSE (upstream error
    // strings, probe details naming internal hosts) is held back from callers
    // without the admin role.
    return request.healthDetail ? report : redactHealthReport(report);
  }

  /**
   * The managed embedding rebuild, from memory's state row (V2.4 item 7.1
   * second half): one cheap single-row read, so the report states what the
   * instance is doing without polling the corpus. Errors here must not take
   * the health endpoint down with them.
   */
  private async checkReindex(): Promise<EmbeddingRebuildHealth | null> {
    try {
      const status = await embeddingRebuildStatus(this.db);
      if (!status) return null;
      return {
        status: status.status,
        phase: status.phase,
        targetModel: status.targetModel,
        factsDone: status.factsDone,
        factsTotal: status.factsTotal,
        startedAt: status.startedAt,
        estimatedSecondsRemaining: status.estimatedSecondsRemaining,
        ...(status.error ? { error: status.error } : {}),
      };
    } catch {
      return null;
    }
  }

  /**
   * The bucket must REPORT default encryption enabled (audit 3.9) —
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
          : { error: 'bucket reports NO default encryption (see the deletion documentation)' }),
      };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: message(error) };
    }
  }

  /** Queue depth + dead-letter + graphile permanent-failure count. */
  private async checkQueue(): Promise<QueueHealthCheck> {
    const started = Date.now();
    try {
      const { depth, deadLettered, permanentlyFailed } = await this.probes.queueDepth();
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
   * Model-gateway reachability — cheap and cached in the gateway (≤1
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
   * The sweep's verdict (spec §11.1 step 4): any open integrity alert or a broken
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

  /**
   * Inbound-mail liveness: a TCP connect to the Haraka SMTP
   * listener (COGETO_MAIL_SMTP_ADDRESS, e.g. mail:2525). Unset → the instance
   * runs without the mail service; report ok with a "not configured" detail so
   * the check never falsely degrades a mail-less deployment.
   *
   * SEC-14: inbound mail is now behind the `mail` compose profile, and the
   * address stays configured whether or not the profile is up. So the
   * CAPABILITY decides first — with mail off there is deliberately no listener
   * to connect to, and probing one would turn an intended posture into a
   * permanent red check.
   */
  private async checkMail(): Promise<HealthCheck> {
    const started = Date.now();
    if (!this.capabilities.mailCapabilityEnabled()) {
      return { ok: true, latencyMs: 0, detail: 'inbound mail capability is off' };
    }
    const address = this.config.mailSmtpAddress;
    if (!address) {
      return { ok: true, latencyMs: 0, detail: 'inbound mail not configured' };
    }
    const [host, portRaw] = address.split(':');
    const port = Number(portRaw ?? 25);
    return new Promise<HealthCheck>((resolve) => {
      const socket = connect({ host: host || '127.0.0.1', port }, () => {
        socket.destroy();
        resolve({ ok: true, latencyMs: Date.now() - started, detail: `SMTP ${address} reachable` });
      });
      socket.setTimeout(3000);
      const fail = (error: string) => {
        socket.destroy();
        resolve({ ok: false, latencyMs: Date.now() - started, error });
      };
      socket.on('timeout', () => fail('connect timeout'));
      socket.on('error', (error) => fail(message(error)));
    });
  }

  private async checkPostgres(): Promise<HealthCheck> {
    const started = Date.now();
    try {
      await this.probes.ping();
      return { ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: message(error) };
    }
  }

  private async checkMigrations(): Promise<HealthCheck> {
    const started = Date.now();
    try {
      const { count, latest } = await this.probes.migrations();
      return {
        ok: count >= 2,
        latencyMs: Date.now() - started,
        detail: latest ? `${count} applied, latest ${latest}` : 'none applied',
        ...(count >= 2 ? {} : { error: 'contractual core (0001/0002) not applied' }),
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
