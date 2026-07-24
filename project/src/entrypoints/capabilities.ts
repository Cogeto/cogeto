import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { CapabilitySummary, ScheduledJobId, ScheduledJobSummary } from '@cogeto/shared';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { IntegritySweep } from '../memory/index';
import type { IntegrityStatus } from '../memory/index';
import { dreamRunStatus } from '../ingestion/index';
import type { DreamRunStatus } from '../ingestion/index';
import { probeLocalRuntime } from '../model-gateway/index';
import { COGETO_CONFIG } from './config';
import type { CogetoConfig } from './config';

/**
 * The capability registry (P6.7, decision 0055): one authoritative, observable
 * answer to "which optional capabilities does this instance run, and are they
 * actually working?" — compose profiles alone are invisible state. Lives in
 * the composition root like the health controller (a deployment concern, not
 * domain); reads other modules ONLY through their public interfaces.
 *
 * Three capability states: `on` (enabled and, where probeable, answering),
 * `unreachable` (enabled but NOT working — the LOUD state: prominent in the
 * panel, a named degradation in /api/health, logged at warn on detection),
 * and `off`. Scheduled jobs join the same surface with `ok` / `overdue` /
 * `failing`. Nothing is inferred silently where it can be checked: redaction,
 * research and local-models are actively probed; demo and consoles are pure
 * configuration (nothing to probe — stated as such via `probed: false`).
 *
 * Snapshots are cached for CAPABILITY_CACHE_TTL_MS (probes are cheap but not
 * free; the dashboard polls every 10 s): 20 s keeps "kill the container, watch
 * it go loud" under half a minute while capping probe traffic.
 */

export const CAPABILITY_CACHE_TTL_MS = 20_000;

/** A run that started this long ago and never finished counts as crashed. */
const STUCK_RUN_HOURS = 2;

const MS_HOUR = 3_600_000;

export interface CapabilitiesSnapshot {
  capabilities: CapabilitySummary[];
  jobs: ScheduledJobSummary[];
}

/** The job read paths, injectable so unit tests can pin fixtures. */
export interface CapabilityJobSources {
  dreaming(): Promise<DreamRunStatus>;
  sweep(): Promise<IntegrityStatus>;
  /** First migration's applied_at — the closest thing to an install time; a
   * never-ran nightly job is not overdue until the instance is old enough. */
  installedAt(): Promise<Date | null>;
}

export const CAPABILITY_JOB_SOURCES = Symbol('CAPABILITY_JOB_SOURCES');

@Injectable()
export class CapabilitiesService {
  private readonly logger = new Logger('capabilities');
  private readonly sources: CapabilityJobSources;
  private cache: { at: number; snapshot: CapabilitiesSnapshot } | null = null;
  /** Loud keys already warned about — warn on transition, not every poll. */
  private warned = new Set<string>();

  constructor(
    @Inject(COGETO_CONFIG) private readonly config: CogetoConfig,
    @Inject(DRIZZLE) db: Db,
    integrity: IntegritySweep,
    @Optional() @Inject(CAPABILITY_JOB_SOURCES) sources?: CapabilityJobSources,
  ) {
    this.sources = sources ?? {
      dreaming: () => dreamRunStatus(db),
      sweep: () => integrity.status(),
      installedAt: async () => {
        const result = await db.execute(
          sql`SELECT min(applied_at) AS installed_at FROM cogeto_migrations`,
        );
        const raw = (result.rows[0] as { installed_at?: string | Date | null } | undefined)
          ?.installed_at;
        return raw ? new Date(raw) : null;
      },
    };
  }

  /** The registry state, cached (probe_cached): honest within the TTL window. */
  async snapshot(now: Date = new Date()): Promise<CapabilitiesSnapshot> {
    if (this.cache && now.getTime() - this.cache.at < CAPABILITY_CACHE_TTL_MS) {
      return this.cache.snapshot;
    }
    const checkedAt = now.toISOString();
    const [capabilities, jobs] = await Promise.all([
      this.assembleCapabilities(checkedAt),
      this.assembleJobs(now, checkedAt),
    ]);
    const snapshot = { capabilities, jobs };
    this.cache = { at: now.getTime(), snapshot };
    this.warnOnLoud(snapshot);
    return snapshot;
  }

  private async assembleCapabilities(checkedAt: string): Promise<CapabilitySummary[]> {
    return Promise.all([
      this.redaction(checkedAt),
      this.research(checkedAt),
      this.demo(checkedAt),
      this.consoles(checkedAt),
      this.localModels(checkedAt),
    ]);
  }

  /** Redaction (§B.8): REDACTION_ENABLED is the authority — the same flag the
   * gateway obeys. Enabled → the sidecar's own /health decides; fail-closed
   * semantics mean an unreachable sidecar makes model calls FAIL, never leak. */
  private async redaction(checkedAt: string): Promise<CapabilitySummary> {
    const base = { id: 'redaction' as const, checkedAt };
    if (!this.config.redactionEnabled) return { ...base, state: 'off', probed: false };
    const probe = await this.probeHttp(`${this.config.redactionUrl}/health`);
    return probe.ok
      ? { ...base, state: 'on', probed: true, detail: 'sidecar healthy; model calls pseudonymized' }
      : {
          ...base,
          state: 'unreachable',
          probed: true,
          error:
            `redaction sidecar unreachable at ${this.config.redactionUrl} (${probe.error}): ` +
            `model calls FAIL CLOSED rather than send unredacted content`,
        };
  }

  /** Research (decision 0042): enabled via the research profile (mirrored in
   * COGETO_COMPOSE_PROFILES) or the explicit flag; SearXNG's /healthz decides. */
  private async research(checkedAt: string): Promise<CapabilitySummary> {
    const base = { id: 'research' as const, checkedAt };
    const enabled = this.config.composeProfiles.includes('research') || this.config.researchEnabled;
    if (!enabled) return { ...base, state: 'off', probed: false };
    if (!this.config.searxngUrl) {
      return {
        ...base,
        state: 'unreachable',
        probed: false,
        error: 'research is enabled but COGETO_SEARXNG_URL is not set: web research is unavailable',
      };
    }
    const probe = await this.probeHttp(`${this.config.searxngUrl}/healthz`);
    return probe.ok
      ? { ...base, state: 'on', probed: true, detail: 'SearXNG healthy; web discovery available' }
      : {
          ...base,
          state: 'unreachable',
          probed: true,
          error:
            `SearXNG unreachable at ${this.config.searxngUrl} (${probe.error}): ` +
            `web research is unavailable until the service is reachable`,
        };
  }

  /** Demo (decision 0022): pure configuration. Demo mode on a production
   * instance is the loud misconfiguration — the guard refuses the seed/reset. */
  private demo(checkedAt: string): CapabilitySummary {
    const base = { id: 'demo' as const, checkedAt, probed: false };
    if (!this.config.demoMode) return { ...base, state: 'off' };
    if (this.config.production) {
      return {
        ...base,
        state: 'unreachable',
        error:
          'COGETO_DEMO_MODE is set on a production instance: the guard refuses the demo ' +
          'seed/reset (decision 0022 ruling 4) — unset one of the two flags',
      };
    }
    return { ...base, state: 'on', detail: 'sandbox mode; a shared demo session is served' };
  }

  /** Consoles (QS-4): profile-bound, localhost-only — the app has nothing to
   * probe (the console edge binds to the HOST loopback), so enabled/disabled
   * is the whole truth and is reported as such. */
  private consoles(checkedAt: string): CapabilitySummary {
    const enabled = this.config.composeProfiles.includes('consoles') || this.config.consolesEnabled;
    return {
      id: 'consoles',
      checkedAt,
      probed: false,
      state: enabled ? 'on' : 'off',
      ...(enabled
        ? { detail: 'localhost-only console edge on :8443; not probeable from the app' }
        : {}),
    };
  }

  /** Local models (decision 0041): enabled when any tier resolves to the local
   * runtime; the boot probe's logic (reachability + models pulled) is reused. */
  private async localModels(checkedAt: string): Promise<CapabilitySummary> {
    const base = { id: 'local-models' as const, checkedAt };
    const probe = await probeLocalRuntime(this.config.modelProviders, { timeoutMs: 3000 });
    if (probe === null) return { ...base, state: 'off', probed: false };
    return probe.ok
      ? { ...base, state: 'on', probed: true, detail: probe.detail }
      : { ...base, state: 'unreachable', probed: true, error: probe.error };
  }

  private async assembleJobs(now: Date, checkedAt: string): Promise<ScheduledJobSummary[]> {
    const overdueAfterHours = this.config.jobsOverdueHours;
    const [dream, sweep, installedAt] = await Promise.all([
      this.sources.dreaming(),
      this.sources.sweep(),
      this.sources.installedAt(),
    ]);

    const dreaming = this.jobSummary({
      id: 'dreaming',
      now,
      checkedAt,
      installedAt,
      overdueAfterHours,
      lastRunAt: dream.lastFinishedAt,
      lastResult: dream.lastCounts ? dreamResultLine(dream.lastCounts) : null,
      neverRanDetail: 'has not run yet (nightly at 03:30 UTC)',
    });
    // The only error signal dream_run carries: the newest run started long ago
    // and never finished — the process died mid-run.
    if (
      dream.newestUnfinished &&
      dream.newestStartedAt &&
      now.getTime() - dream.newestStartedAt.getTime() > STUCK_RUN_HOURS * MS_HOUR
    ) {
      dreaming.state = 'failing';
      dreaming.error = `last run started ${ago(dream.newestStartedAt, now)} and never completed`;
    }

    const sweepJob = this.jobSummary({
      id: 'sweep',
      now,
      checkedAt,
      installedAt,
      overdueAfterHours,
      lastRunAt: sweep.lastSweepAt ? new Date(sweep.lastSweepAt) : null,
      lastResult: sweep.lastReport
        ? `${sweep.lastReport.receiptsChecked} receipt(s), ${sweep.lastReport.identifiersChecked} ` +
          `identifier(s) checked, ${sweep.lastReport.newAlerts} new alert(s)`
        : null,
      neverRanDetail: 'has not run yet (nightly at 03:00 UTC)',
    });

    return [dreaming, sweepJob];
  }

  private jobSummary(args: {
    id: ScheduledJobId;
    now: Date;
    checkedAt: string;
    installedAt: Date | null;
    overdueAfterHours: number;
    lastRunAt: Date | null;
    lastResult: string | null;
    neverRanDetail: string;
  }): ScheduledJobSummary {
    const { id, now, checkedAt, installedAt, overdueAfterHours, lastRunAt, lastResult } = args;
    const thresholdMs = overdueAfterHours * MS_HOUR;
    const summary: ScheduledJobSummary = {
      id,
      state: 'ok',
      lastRunAt: lastRunAt?.toISOString() ?? null,
      lastResult: lastRunAt ? lastResult : args.neverRanDetail,
      overdueAfterHours,
      checkedAt,
    };
    if (lastRunAt) {
      if (now.getTime() - lastRunAt.getTime() > thresholdMs) {
        summary.state = 'overdue';
        summary.error = `no successful run since ${lastRunAt.toISOString()} (threshold ${overdueAfterHours} h)`;
      }
    } else if (installedAt && now.getTime() - installedAt.getTime() > thresholdMs) {
      // Never ran, and the instance is older than a full nightly window.
      summary.state = 'overdue';
      summary.error = `never ran, and the instance is older than ${overdueAfterHours} h`;
    }
    return summary;
  }

  /** Loud states as named degradations for /api/health's overall verdict. */
  static loudness(snapshot: CapabilitiesSnapshot): string[] {
    return [
      ...snapshot.capabilities.filter((c) => c.state === 'unreachable').map((c) => c.id),
      ...snapshot.jobs.filter((j) => j.state !== 'ok').map((j) => `job:${j.id}`),
    ];
  }

  private warnOnLoud(snapshot: CapabilitiesSnapshot): void {
    const loud = new Set<string>();
    for (const c of snapshot.capabilities) {
      if (c.state === 'unreachable') {
        loud.add(c.id);
        if (!this.warned.has(c.id)) this.logger.warn(`capability ${c.id} is loud: ${c.error}`);
      }
    }
    for (const j of snapshot.jobs) {
      const key = `job:${j.id}`;
      if (j.state !== 'ok') {
        loud.add(key);
        if (!this.warned.has(key)) this.logger.warn(`job ${j.id} is ${j.state}: ${j.error ?? ''}`);
      }
    }
    this.warned = loud;
  }

  private async probeHttp(url: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      return response.ok ? { ok: true } : { ok: false, error: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** Compact one-line result from the dream report counts (counts_json). */
function dreamResultLine(counts: Record<string, number>): string {
  const parts = (
    [
      ['merged', 'merged'],
      ['contradictions', 'contradictions'],
      ['superseded', 'superseded'],
      ['outdated', 'outdated'],
      ['dormantFlagged', 'flagged dormant'],
    ] as const
  )
    .filter(([key]) => typeof counts[key] === 'number')
    .map(([key, label]) => `${counts[key]} ${label}`);
  return parts.length > 0 ? parts.join(', ') : 'completed';
}

/**
 * The boot banner (P6.7 Issue C): one clearly-delimited block stating every
 * capability's state at boot and the two jobs' last runs. Exact truth, every
 * boot — built from the same registry snapshot the panel and /api/health use.
 */
export function formatCapabilitiesBanner(snapshot: CapabilitiesSnapshot, now: Date): string {
  const capability = (c: CapabilitySummary): string => {
    if (c.state === 'off') return `${c.id} OFF`;
    if (c.state === 'unreachable') return `${c.id} ON (UNREACHABLE)`;
    return `${c.id} ON (${c.probed ? 'healthy' : 'configured'})`;
  };
  const job = (j: ScheduledJobSummary): string => {
    const when = j.lastRunAt ? `last ran ${ago(new Date(j.lastRunAt), now)}` : 'never ran';
    return j.state === 'ok' ? `${j.id} ${when}` : `${j.id} ${when} (${j.state.toUpperCase()})`;
  };
  return (
    `Capabilities: ${snapshot.capabilities.map(capability).join(' | ')}. ` +
    `Jobs: ${snapshot.jobs.map(job).join(' | ')}.`
  );
}

/** Coarse relative time for log lines: 42m ago / 6h ago / 3d ago. */
function ago(then: Date, now: Date): string {
  const ms = Math.max(0, now.getTime() - then.getTime());
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
