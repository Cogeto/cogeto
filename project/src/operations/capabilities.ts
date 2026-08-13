import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { connect } from 'node:net';
import type { CapabilitySummary, ScheduledJobId, ScheduledJobSummary } from '@cogeto/shared';
import { DRIZZLE, InstanceProbes } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { IntegritySweep } from '../memory/index';
import type { IntegrityStatus } from '../memory/index';
import { dreamRunStatus } from '../ingestion/index';
import type { DreamRunStatus } from '../ingestion/index';
import {
  DEFAULT_REASONING_PROBE_TIMEOUT_MS,
  DEFAULT_VISION_PROBE_TIMEOUT_MS,
  ModelGateway,
  probeReasoning,
  probeVision,
} from '../model-gateway/index';
import { OPERATIONS_OPTIONS } from './operations.options';
import type { OperationsOptions } from './operations.options';

/**
 * The capability registry: one authoritative, observable
 * answer to "which optional capabilities does this instance run, and are they
 * actually working?" — compose profiles alone are invisible state. Lives in the
 * `operations` context beside the health report it feeds; reads other modules
 * ONLY through their public interfaces.
 *
 * Three capability states: `on` (enabled and, where probeable, answering),
 * `unreachable` (enabled but NOT working — the LOUD state: prominent in the
 * panel, a named degradation in /api/health, logged at warn on detection),
 * and `off`. Scheduled jobs join the same surface with `ok` / `overdue` /
 * `failing`. Nothing is inferred silently where it can be checked: redaction,
 * research, vision and reasoning are actively probed; demo, consoles and the
 * model configuration are pure
 * configuration (nothing to probe — stated as such via `probed: false`).
 *
 * Snapshots are cached for CAPABILITY_CACHE_TTL_MS (probes are cheap but not
 * free; the dashboard polls every 10 s): 20 s keeps "kill the container, watch
 * it go loud" under half a minute while capping probe traffic.
 */

export const CAPABILITY_CACHE_TTL_MS = 20_000;

/**
 * The reasoning probe's own, longer window (Part B of reasoning support).
 * Unlike every other probe here, this one costs a MODEL COMPLETION, and unlike
 * the vision probe it applies to every configured instance, not only the few
 * with a vision binding — re-running it per 20-second snapshot would turn the
 * panel's poll into steady hosted-model traffic. Ten minutes bounds the only
 * staleness that matters (a runtime restarted the other way), and the adapter
 * keeps learning from every real response in between.
 */
export const REASONING_PROBE_TTL_MS = 600_000;

/**
 * The vision probe's own window (issue #418), the reasoning precedent: the
 * probe sends a real image, and on a reasoning vision binding the model now
 * THINKS about it for 10 to 15 seconds before answering — per 20-second
 * snapshot that made the panel's poll both slow and a steady image feed to
 * the model runtime. Three minutes keeps "kill the runtime, watch it go loud"
 * in the minutes rather than the seconds, which is the price of the probe
 * having become a real model call; the reading ladder's own per-document
 * probe (`ProbedVisionSource`, 60 s) is unchanged and still catches a dead
 * runtime document-by-document.
 */
export const VISION_PROBE_TTL_MS = 180_000;

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

/**
 * The connector fleet's health, a port in the CAPABILITY_JOB_SOURCES shape
 * (V2.5 item 8.1, issue A4): operations declares it, the connectors platform
 * implements it, the composition root binds it. Optional: a root without the
 * platform (or a bare test construction) reports the entry as off.
 */
export interface ConnectorHealthPort {
  summary(): Promise<{
    configured: number;
    healthy: number;
    syncing: number;
    degraded: { name: string | null; reason: string | null }[];
    needsReauth: { name: string | null }[];
    disabled: number;
  }>;
}

export const CONNECTOR_HEALTH = Symbol('CONNECTOR_HEALTH');

@Injectable()
export class CapabilitiesService {
  private readonly logger = new Logger('capabilities');
  private readonly sources: CapabilityJobSources;
  private cache: { at: number; snapshot: CapabilitiesSnapshot } | null = null;
  /** The reasoning probe's own cache (REASONING_PROBE_TTL_MS): a completion
   * per snapshot would be too much traffic; a stale entry keeps its honest
   * original checkedAt. */
  private reasoningCache: { at: number; summary: CapabilitySummary } | null = null;
  /** The vision probe's own cache (VISION_PROBE_TTL_MS, issue #418): an image
   * through a thinking model per snapshot was the panel's 10-second hang. */
  private visionCache: { at: number; summary: CapabilitySummary } | null = null;
  /** Single-flight guard for the background refresh (issue #418): ten stale
   * polls must trigger ONE rebuild, not ten. */
  private refreshInFlight: Promise<void> | null = null;
  /** Loud keys already warned about — warn on transition, not every poll. */
  private warned = new Set<string>();

  constructor(
    @Inject(OPERATIONS_OPTIONS) private readonly config: OperationsOptions,
    @Inject(DRIZZLE) db: Db,
    integrity: IntegritySweep,
    probes: InstanceProbes,
    @Optional() @Inject(CAPABILITY_JOB_SOURCES) sources?: CapabilityJobSources,
    /** The seam the vision probe goes through. Optional so a bare construction
     * (unit tests, a root without the gateway) reports vision as off. */
    @Optional() private readonly gateway?: ModelGateway,
    /** The connector fleet (V2.5 item 8.1); absent → the entry reports off. */
    @Optional() @Inject(CONNECTOR_HEALTH) private readonly connectorHealth?: ConnectorHealthPort,
  ) {
    this.sources = sources ?? {
      dreaming: () => dreamRunStatus(db),
      sweep: () => integrity.status(),
      // The migration ledger is infrastructure's; this used to be a raw
      // `min(applied_at)` from a composition root (recorded exception B11).
      installedAt: () => probes.installedAt(),
    };
  }

  /**
   * The registry state, stale-while-revalidate (issue #418): a fresh cache is
   * served as before; a STALE cache is served immediately while ONE background
   * pass rebuilds it, because the vision probe on a reasoning binding is a
   * 10-to-15-second model call and a panel poll must never sit behind it. The
   * very first read (the boot banner's) still builds synchronously — there is
   * nothing stale to serve, and the banner must state the truth, not a blank.
   *
   * Honesty is per entry, not per response: every summary carries the
   * `checkedAt` of the pass that measured it, and a dead capability still goes
   * loud (warn log + degraded health) on the next background pass rather than
   * on somebody's page load.
   */
  async snapshot(now: Date = new Date()): Promise<CapabilitiesSnapshot> {
    if (this.cache && now.getTime() - this.cache.at < CAPABILITY_CACHE_TTL_MS) {
      return this.cache.snapshot;
    }
    if (this.cache) {
      this.scheduleRefresh(now);
      return this.cache.snapshot;
    }
    await this.rebuild(now);
    return this.cache!.snapshot;
  }

  /** One background rebuild at a time; a failed pass keeps the stale snapshot
   * and says so at warn, never throws into a poll. */
  private scheduleRefresh(now: Date): void {
    if (this.refreshInFlight) return;
    this.refreshInFlight = this.rebuild(now)
      .catch((error: unknown) => {
        this.logger.warn(
          `capability snapshot refresh failed; serving the previous snapshot: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        this.refreshInFlight = null;
      });
  }

  /** Waits out any in-flight background refresh — the deterministic seam the
   * unit suite uses; nothing on a request path calls it. */
  async settle(): Promise<void> {
    await this.refreshInFlight;
  }

  private async rebuild(now: Date): Promise<void> {
    const checkedAt = now.toISOString();
    const [capabilities, jobs] = await Promise.all([
      this.assembleCapabilities(checkedAt),
      this.assembleJobs(now, checkedAt),
    ]);
    const snapshot = { capabilities, jobs };
    this.cache = { at: now.getTime(), snapshot };
    this.warnOnLoud(snapshot);
  }

  private async assembleCapabilities(checkedAt: string): Promise<CapabilitySummary[]> {
    // The reasoning probe runs FIRST, alone (Part B of reasoning support): its
    // side effect arms the maxTokens headroom in the adapter, and the vision
    // probe's small cap depends on that headroom when the vision binding is a
    // reasoning model. Probing them concurrently would report vision broken on
    // the one snapshot that matters, the boot banner's.
    const reasoning = await this.reasoning(checkedAt);
    const models = this.models(checkedAt);
    const [redaction, research, mail, demo, consoles, vision, connectors] = await Promise.all([
      this.redaction(checkedAt),
      this.research(checkedAt),
      this.mail(checkedAt),
      this.demo(checkedAt),
      this.consoles(checkedAt),
      this.vision(checkedAt),
      this.connectors(checkedAt),
    ]);
    return [models, redaction, research, mail, demo, consoles, reasoning, vision, connectors];
  }

  /**
   * The model configuration itself. ON with the configuration id when the
   * three core tiers are assigned; OFF with the pointer to the Providers page
   * when nothing is configured, which is the normal first-run state and never
   * a degradation. Deliberately never `unreachable` from here: this entry
   * reports what is CONFIGURED, and whether a configured provider actually
   * answers is the gateway health check's finding.
   */
  private models(checkedAt: string): CapabilitySummary {
    const base = { id: 'models' as const, checkedAt, probed: false };
    const providers = this.config.modelProviders;
    return providers.configured
      ? { ...base, state: 'on', detail: `configuration ${providers.id}` }
      : {
          ...base,
          state: 'off',
          detail:
            'no model provider configured; capture, ingestion and chat are off until an ' +
            'administrator adds one under Providers in the interface',
        };
  }

  /**
   * The connector fleet (V2.5 item 8.1, issue A4): off when none is
   * configured (an instance without connectors is not degraded), on while
   * every configured connector is healthy, LOUD when any is degraded or
   * needs reauthorisation, with the actionable message naming the connector
   * and the fix. States come from rows, not probes: the sync engine and the
   * maintenance pass are what measure the upstream.
   */
  private async connectors(checkedAt: string): Promise<CapabilitySummary> {
    const base = { id: 'connectors' as const, checkedAt };
    if (!this.connectorHealth) return { ...base, state: 'off', probed: false };
    try {
      const fleet = await this.connectorHealth.summary();
      if (fleet.configured === 0) return { ...base, state: 'off', probed: false };
      const broken = [
        ...fleet.needsReauth.map((c) => ({
          name: c.name,
          fix: 'reconnect it from Settings',
        })),
        ...fleet.degraded.map((c) => ({
          name: c.name,
          fix:
            c.reason === 'webhook_lapsed'
              ? 'webhook lapsed; polling carries it'
              : 'see its sync runs',
        })),
      ];
      if (broken.length > 0) {
        const first = broken[0]!;
        return {
          ...base,
          state: 'unreachable',
          probed: true,
          detail: `${fleet.configured} configured, ${broken.length} needing attention`,
          error: `connector ${first.name ?? '(unnamed)'} needs attention: ${first.fix}`,
        };
      }
      return {
        ...base,
        state: 'on',
        probed: true,
        detail: `${fleet.configured} configured${fleet.syncing > 0 ? `, ${fleet.syncing} syncing` : ''}${fleet.disabled > 0 ? `, ${fleet.disabled} disabled` : ''}`,
      };
    } catch (error) {
      return {
        ...base,
        state: 'unreachable',
        probed: true,
        error: `connector state unreadable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** Redaction (spec §12.2): REDACTION_ENABLED is the authority — the same flag the
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

  /** Research: enabled via the research profile (mirrored in
   * COGETO_COMPOSE_PROFILES) or the explicit flag; SearXNG's /healthz decides. */
  private async research(checkedAt: string): Promise<CapabilitySummary> {
    const base = { id: 'research' as const, checkedAt };
    // The Ana sandbox: research runs on bundled fixture pages,
    // never the live web — honest in the panel, no SearXNG probe.
    if (this.config.demoMode) {
      return {
        ...base,
        state: 'on',
        probed: false,
        detail: 'sandbox: web discovery serves bundled fixture pages, never the live web',
      };
    }
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

  /**
   * Inbound email capture (audit 2.0 SEC-14). Enabled via the `mail` compose
   * profile (mirrored in COGETO_COMPOSE_PROFILES) or the explicit flag. Off is
   * the DEFAULT and the safe state: with the profile down, no internet-facing
   * SMTP listener runs at all, which is the whole point of the finding.
   *
   * Enabled and reachable is probed for real — a TCP connect to the Haraka
   * listener, the same signal /api/health uses — so "enabled but the container
   * is down" is loud rather than silently swallowing forwarded mail.
   */
  private async mail(checkedAt: string): Promise<CapabilitySummary> {
    const base = { id: 'mail' as const, checkedAt };
    if (!this.mailCapabilityEnabled()) return { ...base, state: 'off', probed: false };
    const address = this.config.mailSmtpAddress;
    if (!address) {
      return {
        ...base,
        state: 'unreachable',
        probed: false,
        error:
          'inbound mail is enabled but COGETO_MAIL_SMTP_ADDRESS is not set: ' +
          'forwarded mail cannot be received',
      };
    }
    const probe = await probeTcp(address);
    return probe.ok
      ? {
          ...base,
          state: 'on',
          probed: true,
          detail: `inbound SMTP reachable at ${address}; capture routes by sender`,
        }
      : {
          ...base,
          state: 'unreachable',
          probed: true,
          error:
            `inbound SMTP unreachable at ${address} (${probe.error}): ` +
            `forwarded mail is not being received`,
        };
  }

  /** The one authority on whether this instance runs inbound mail (SEC-14). */
  mailCapabilityEnabled(): boolean {
    return this.config.composeProfiles.includes('mail') || this.config.mailEnabled;
  }

  /** Demo: pure configuration. Demo mode on a production
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
          'seed/reset: unset one of the two flags',
      };
    }
    return { ...base, state: 'on', detail: 'sandbox mode; a shared demo session is served' };
  }

  /** Consoles: profile-bound, localhost-only — the app has nothing to
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

  /** Local models: enabled when any tier resolves to the local
   * runtime; the boot probe's logic (reachability + models pulled) is reused. */
  /**
   * Vision (V2.1 item 4.1): can this instance read a page that is a picture?
   *
   * Probed by SENDING AN IMAGE, never by reading a model name. A GGUF model is
   * multimodal only when its multimodal projector is loaded beside the weights,
   * the same weights are served either way, and `ollama list` shows no
   * difference — so a configuration flag would be a claim and this is a check.
   *
   * Re-probed on the registry's normal schedule, which is what turns "the
   * runtime went away" into a panel state rather than a surprise in the middle
   * of ingesting a hundred-page scan. The reasons are kept distinct because
   * they send an operator to four different places; `image_rejected` in
   * particular names the projector, which is where the problem almost always
   * is and the last place an operator looks.
   */
  private async vision(checkedAt: string): Promise<CapabilitySummary> {
    const at = Date.parse(checkedAt);
    if (this.visionCache && at - this.visionCache.at < VISION_PROBE_TTL_MS) {
      return this.visionCache.summary;
    }
    const base = { id: 'vision' as const, checkedAt };
    let summary: CapabilitySummary;
    if (!this.gateway) {
      summary = { ...base, state: 'off', probed: false };
    } else {
      // The SAME deadline the reader uses. An 8-second panel probe against a
      // 30-second reader probe would report a working remote runtime as broken
      // while documents were being read by it.
      const probe = await probeVision(this.gateway, this.config.modelProviders, {
        timeoutMs: this.config.visionProbeTimeoutMs ?? DEFAULT_VISION_PROBE_TIMEOUT_MS,
      });
      if (probe.ok) {
        summary = { ...base, state: 'on', probed: true, detail: probe.detail };
      } else if (probe.reason === 'not_configured') {
        // Not configured is OFF, not broken: an instance that never asked for
        // vision is not degraded, it simply stops the reading ladder at OCR.
        summary = { ...base, state: 'off', probed: false, detail: probe.error };
      } else {
        summary = { ...base, state: 'unreachable', probed: true, error: probe.error };
      }
    }
    this.visionCache = { at, summary };
    return summary;
  }

  /**
   * Reasoning (Part B of reasoning support): does the generation model return
   * its thinking in a separate reasoning field?
   *
   * Probed by SENDING A PROMPT, never by reading a model name or a flag, for
   * the same reason vision is probed: the identical weights are served both
   * ways, and only a response says which way this instance got them. On means
   * the adapter multiplies maxTokens so reasoning cannot silently consume an
   * answer's entire token budget; off is a complete, healthy answer — a
   * non-reasoning instance is not degraded, and nothing about its requests
   * changes. A failed probe also reports off (with the failure in the detail)
   * rather than loud: the gateway health check already owns "the endpoint is
   * down", and a missing headroom on a dead endpoint breaks nothing further.
   */
  private async reasoning(checkedAt: string): Promise<CapabilitySummary> {
    const at = Date.parse(checkedAt);
    if (this.reasoningCache && at - this.reasoningCache.at < REASONING_PROBE_TTL_MS) {
      return this.reasoningCache.summary;
    }
    const base = { id: 'reasoning' as const, checkedAt };
    let summary: CapabilitySummary;
    if (!this.gateway) {
      summary = { ...base, state: 'off', probed: false };
    } else {
      const probe = await probeReasoning(this.gateway, this.config.modelProviders, {
        timeoutMs: this.config.reasoningProbeTimeoutMs ?? DEFAULT_REASONING_PROBE_TIMEOUT_MS,
      });
      summary = probe.probed
        ? {
            ...base,
            state: probe.reasoning ? 'on' : 'off',
            probed: true,
            detail: probe.error ? `${probe.detail}: ${probe.error}` : probe.detail,
          }
        : { ...base, state: 'off', probed: false, detail: probe.detail };
    }
    this.reasoningCache = { at, summary };
    return summary;
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

/**
 * A TCP liveness probe for a `host:port` address — the only honest check for a
 * plain SMTP listener (SEC-14). Same shape as probeHttp: never throws.
 */
export async function probeTcp(
  address: string,
  timeoutMs = 3000,
): Promise<{ ok: boolean; error?: string }> {
  const [host, portRaw] = address.split(':');
  const port = Number(portRaw ?? 25);
  if (!Number.isFinite(port) || port <= 0) {
    return { ok: false, error: `malformed address '${address}'` };
  }
  return new Promise((resolve) => {
    const socket = connect({ host: host || '127.0.0.1', port }, () => {
      socket.destroy();
      resolve({ ok: true });
    });
    socket.setTimeout(timeoutMs);
    const fail = (error: string): void => {
      socket.destroy();
      resolve({ ok: false, error });
    };
    socket.on('timeout', () => fail('connect timeout'));
    socket.on('error', (error) => fail(error instanceof Error ? error.message : String(error)));
  });
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
 * The boot banner (Issue C): one clearly-delimited block stating every
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
