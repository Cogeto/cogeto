import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { IntegrityStatus, IntegritySweep } from '../memory/index';
import type { DreamRunStatus } from '../ingestion/index';
import type { ModelGateway, ResolvedModelProviders } from '../model-gateway/index';
import type { Db, InstanceProbes } from '../infrastructure/index';
import {
  CAPABILITY_CACHE_TTL_MS,
  CapabilitiesService,
  formatCapabilitiesBanner,
  REASONING_PROBE_TTL_MS,
  VISION_PROBE_TTL_MS,
} from './capabilities';
import type { CapabilityJobSources } from './capabilities';
import type { OperationsOptions } from './operations.options';

/**
 * The capability registry — unit surface
 *
 *   registry_states — each capability reports the correct state across
 *     enabled / disabled / unreachable configurations.
 *   jobs_overdue    — a stale dream_run (and sweep) flips the job to overdue
 *     exactly at the frozen threshold; a stuck unfinished run reports failing.
 *   probe_cached    — repeated reads within the cache window hit the cache.
 *   banner_accurate — the boot banner is built from the same snapshot and
 *     states the exact truth.
 *
 * Probes are exercised through a stubbed global fetch; the job read paths
 * through the injectable sources (the real SQL is covered by the integration
 * spec next to this file).
 */

const NOW = new Date('2026-07-24T12:00:00Z');
const HOUR = 3_600_000;

const unconfiguredProviders = {
  configured: false,
  ollama: null,
} as unknown as ResolvedModelProviders;

const ollamaProviders = {
  configured: true,
  ollama: {
    baseUrl: 'http://10.0.0.1:11434',
    timeoutsMs: { pipeline: 1, answer: 1, embedding: 1 },
  },
  tiers: {
    pipeline: { provider: 'ollama', model: 'gemma3:12b' },
    answer: { provider: 'ollama', model: 'gemma3:12b' },
    embedding: { provider: 'ollama', model: 'bge-m3' },
  },
} as unknown as ResolvedModelProviders;

function config(overrides: Partial<OperationsOptions> = {}): OperationsOptions {
  return {
    redactionEnabled: false,
    redactionUrl: 'http://redaction:8080',
    composeProfiles: [],
    researchEnabled: false,
    consolesEnabled: false,
    mailEnabled: false,
    mailSmtpAddress: 'mail:2525',
    searxngUrl: 'http://searxng:8080',
    demoMode: false,
    production: false,
    jobsOverdueHours: 26,
    modelProviders: unconfiguredProviders,
    ...overrides,
  } as OperationsOptions;
}

const quietJobs: CapabilityJobSources = {
  dreaming: async (): Promise<DreamRunStatus> => ({
    lastFinishedAt: new Date(NOW.getTime() - 6 * HOUR),
    lastCounts: { merged: 2, contradictions: 1, superseded: 0, outdated: 3, dormantFlagged: 0 },
    newestStartedAt: new Date(NOW.getTime() - 6 * HOUR),
    newestUnfinished: false,
  }),
  sweep: async (): Promise<IntegrityStatus> => ({
    lastSweepAt: new Date(NOW.getTime() - 7 * HOUR).toISOString(),
    lastReport: {
      receiptsChecked: 4,
      identifiersChecked: 9,
      objectsScanned: 0,
      payloadsChecked: 0,
      payloadsHealed: 0,
      newAlerts: 0,
      openAlerts: 0,
      chainOk: true,
    },
    openAlerts: 0,
  }),
  installedAt: async () => new Date(NOW.getTime() - 30 * 24 * HOUR),
};

function service(
  cfg: OperationsOptions,
  jobs: CapabilityJobSources = quietJobs,
): CapabilitiesService {
  return new CapabilitiesService(
    cfg,
    null as unknown as Db,
    null as unknown as IntegritySweep,
    null as unknown as InstanceProbes,
    jobs,
  );
}

/** Stub fetch answering per-URL; records every probed URL. */
function stubFetch(answer: (url: string) => { status: number } | 'refuse'): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const target = String(url);
      calls.push(target);
      const result = answer(target);
      if (result === 'refuse') throw new Error('ECONNREFUSED');
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        json: async () => ({ models: [{ name: 'gemma3:12b' }, { name: 'bge-m3:latest' }] }),
      } as Response;
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const byId = (snapshot: Awaited<ReturnType<CapabilitiesService['snapshot']>>, id: string) =>
  snapshot.capabilities.find((c) => c.id === id)!;

describe('registry_states', () => {
  it('everything off on a bare default configuration — and nothing is probed', async () => {
    const calls = stubFetch(() => ({ status: 200 }));
    const snapshot = await service(config()).snapshot(NOW);
    for (const id of ['redaction', 'research', 'mail', 'demo', 'consoles', 'local-models']) {
      expect(byId(snapshot, id).state).toBe('off');
    }
    expect(calls).toEqual([]); // disabled capabilities are never probed
  });

  it('redaction: healthy sidecar → on; dead sidecar → unreachable with the fail-closed consequence', async () => {
    stubFetch(() => ({ status: 200 }));
    const on = await service(config({ redactionEnabled: true })).snapshot(NOW);
    expect(byId(on, 'redaction')).toMatchObject({ state: 'on', probed: true });

    vi.unstubAllGlobals();
    stubFetch(() => 'refuse');
    const down = await service(config({ redactionEnabled: true })).snapshot(NOW);
    const redaction = byId(down, 'redaction');
    expect(redaction.state).toBe('unreachable');
    expect(redaction.error).toContain('FAIL CLOSED');
    expect(redaction.error).toContain('http://redaction:8080');
  });

  it('research: enabled via the profile list or the explicit flag; SearXNG health decides', async () => {
    stubFetch(() => ({ status: 200 }));
    const viaProfile = await service(config({ composeProfiles: ['research'] })).snapshot(NOW);
    expect(byId(viaProfile, 'research').state).toBe('on');
    const viaFlag = await service(config({ researchEnabled: true })).snapshot(NOW);
    expect(byId(viaFlag, 'research').state).toBe('on');

    vi.unstubAllGlobals();
    stubFetch(() => 'refuse');
    const down = await service(config({ composeProfiles: ['research'] })).snapshot(NOW);
    const research = byId(down, 'research');
    expect(research.state).toBe('unreachable');
    expect(research.error).toContain('unavailable until the service is reachable');
  });

  it('research enabled without a SearXNG URL is loud, not silently off', async () => {
    stubFetch(() => ({ status: 200 }));
    const snapshot = await service(
      config({ composeProfiles: ['research'], searxngUrl: undefined }),
    ).snapshot(NOW);
    const research = byId(snapshot, 'research');
    expect(research.state).toBe('unreachable');
    expect(research.error).toContain('COGETO_SEARXNG_URL');
  });

  it('mail: off by default (SEC-14) — enabled via the profile or the flag, and then probed for real', async () => {
    // The whole point of the finding: an instance that does not use email
    // capture must run NO inbound SMTP listener, so `off` is the default and
    // nothing is probed in that state.
    stubFetch(() => ({ status: 200 }));
    expect(byId(await service(config()).snapshot(NOW), 'mail')).toMatchObject({
      state: 'off',
      probed: false,
    });

    // Enabled and the listener answers → on, probed for real (a TCP connect,
    // not an HTTP probe: Haraka speaks SMTP).
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const live = await service(
      config({ composeProfiles: ['mail'], mailSmtpAddress: `127.0.0.1:${port}` }),
    ).snapshot(NOW);
    expect(byId(live, 'mail')).toMatchObject({ state: 'on', probed: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));

    // Enabled but nothing listening → LOUD, not silently off: forwarded mail
    // would be dropped on the floor.
    const dead = await service(
      config({ mailEnabled: true, mailSmtpAddress: `127.0.0.1:${port}` }),
    ).snapshot(NOW);
    expect(byId(dead, 'mail').state).toBe('unreachable');
    expect(byId(dead, 'mail').error).toMatch(/not being received/);
  });

  it('demo: on when allowed; LOUD when the production guard blocks it', async () => {
    stubFetch(() => ({ status: 200 }));
    const sandbox = await service(config({ demoMode: true })).snapshot(NOW);
    expect(byId(sandbox, 'demo')).toMatchObject({ state: 'on', probed: false });

    const blocked = await service(config({ demoMode: true, production: true })).snapshot(NOW);
    const demo = byId(blocked, 'demo');
    expect(demo.state).toBe('unreachable');
    expect(demo.error).toContain('production');
  });

  it('consoles: enabled/disabled only — never probed', async () => {
    const calls = stubFetch(() => ({ status: 200 }));
    const snapshot = await service(config({ composeProfiles: ['consoles'] })).snapshot(NOW);
    expect(byId(snapshot, 'consoles')).toMatchObject({ state: 'on', probed: false });
    expect(calls).toEqual([]);
  });

  it('local-models: reachable runtime with the models pulled → on; dead runtime → unreachable', async () => {
    stubFetch(() => ({ status: 200 }));
    const on = await service(config({ modelProviders: ollamaProviders })).snapshot(NOW);
    expect(byId(on, 'local-models')).toMatchObject({ state: 'on', probed: true });

    vi.unstubAllGlobals();
    stubFetch(() => 'refuse');
    const down = await service(config({ modelProviders: ollamaProviders })).snapshot(NOW);
    const local = byId(down, 'local-models');
    expect(local.state).toBe('unreachable');
    expect(local.error).toContain('COGETO_OLLAMA_BASE_URL');
  });

  it('loudness: unreachable capabilities and non-ok jobs are the named degradations', async () => {
    stubFetch(() => 'refuse');
    const snapshot = await service(config({ redactionEnabled: true })).snapshot(NOW);
    expect(CapabilitiesService.loudness(snapshot)).toEqual(['redaction']);
  });
});

describe('jobs_overdue', () => {
  const dreamingAt = (lastFinished: Date | null, extra: Partial<DreamRunStatus> = {}) => ({
    ...quietJobs,
    dreaming: async (): Promise<DreamRunStatus> => ({
      lastFinishedAt: lastFinished,
      lastCounts: lastFinished ? { merged: 1 } : null,
      newestStartedAt: lastFinished,
      newestUnfinished: false,
      ...extra,
    }),
  });

  it('a stale dream_run flips the job to overdue exactly past the threshold', async () => {
    stubFetch(() => ({ status: 200 }));
    const fresh = await service(config(), dreamingAt(new Date(NOW.getTime() - 25 * HOUR))).snapshot(
      NOW,
    );
    expect(fresh.jobs.find((j) => j.id === 'dreaming')!.state).toBe('ok');

    const stale = await service(config(), dreamingAt(new Date(NOW.getTime() - 27 * HOUR))).snapshot(
      NOW,
    );
    const dreaming = stale.jobs.find((j) => j.id === 'dreaming')!;
    expect(dreaming.state).toBe('overdue');
    expect(dreaming.error).toContain('threshold 26 h');
  });

  it('the threshold is configurable (COGETO_JOBS_OVERDUE_HOURS)', async () => {
    stubFetch(() => ({ status: 200 }));
    const snapshot = await service(
      config({ jobsOverdueHours: 48 }),
      dreamingAt(new Date(NOW.getTime() - 27 * HOUR)),
    ).snapshot(NOW);
    expect(snapshot.jobs.find((j) => j.id === 'dreaming')!.state).toBe('ok');
  });

  it('never ran: quiet on a young instance, overdue once the instance is old enough', async () => {
    stubFetch(() => ({ status: 200 }));
    const young = {
      ...dreamingAt(null),
      installedAt: async () => new Date(NOW.getTime() - 2 * HOUR),
    };
    const quiet = await service(config(), young).snapshot(NOW);
    const freshJob = quiet.jobs.find((j) => j.id === 'dreaming')!;
    expect(freshJob.state).toBe('ok');
    expect(freshJob.lastResult).toContain('has not run yet');

    const old = {
      ...dreamingAt(null),
      installedAt: async () => new Date(NOW.getTime() - 30 * HOUR),
    };
    const loud = await service(config(), old).snapshot(NOW);
    expect(loud.jobs.find((j) => j.id === 'dreaming')!.state).toBe('overdue');
  });

  it('a run that started hours ago and never finished reports failing', async () => {
    stubFetch(() => ({ status: 200 }));
    const stuck = dreamingAt(new Date(NOW.getTime() - 20 * HOUR), {
      newestStartedAt: new Date(NOW.getTime() - 3 * HOUR),
      newestUnfinished: true,
    });
    const snapshot = await service(config(), stuck).snapshot(NOW);
    const dreaming = snapshot.jobs.find((j) => j.id === 'dreaming')!;
    expect(dreaming.state).toBe('failing');
    expect(dreaming.error).toContain('never completed');
  });

  it('the sweep goes overdue on a stale last sweep', async () => {
    stubFetch(() => ({ status: 200 }));
    const staleSweep: CapabilityJobSources = {
      ...quietJobs,
      sweep: async () => ({
        lastSweepAt: new Date(NOW.getTime() - 27 * HOUR).toISOString(),
        lastReport: null,
        openAlerts: 0,
      }),
    };
    const snapshot = await service(config(), staleSweep).snapshot(NOW);
    expect(snapshot.jobs.find((j) => j.id === 'sweep')!.state).toBe('overdue');
  });
});

describe('reasoning_capability', () => {
  const reasoningProviders = {
    configured: true,
    reasoningHeadroom: 4,
    ollama: null,
    tiers: {
      pipeline: { provider: 'openai', model: 'ff711' },
      answer: { provider: 'openai', model: 'ff711' },
      embedding: { provider: 'mistral', model: 'mistral-embed' },
    },
    vision: { provider: 'openai', model: 'ff711' },
  } as unknown as ResolvedModelProviders;

  function probedService(reasoned: boolean): {
    svc: CapabilitiesService;
    order: string[];
    completeCalls: () => number;
  } {
    const order: string[] = [];
    const complete = vi.fn(async () => {
      order.push('complete');
      return reasoned ? { text: 'OK.', reasoned: true } : { text: 'OK.' };
    });
    const gateway = {
      complete,
      describeImage: async (): Promise<{ text: string }> => {
        order.push('describeImage');
        return { text: 'a blue square' };
      },
    } as unknown as ModelGateway;
    const svc = new CapabilitiesService(
      config({ modelProviders: reasoningProviders }),
      null as unknown as Db,
      null as unknown as IntegritySweep,
      null as unknown as InstanceProbes,
      quietJobs,
      gateway,
    );
    return { svc, order, completeCalls: () => complete.mock.calls.length };
  }

  it('a probed reasoning field reports on; plain answers report a healthy off', async () => {
    const on = await probedService(true).svc.snapshot(NOW);
    expect(byId(on, 'reasoning')).toMatchObject({ state: 'on', probed: true });
    expect(byId(on, 'reasoning').detail).toContain('openai/ff711');

    const off = await probedService(false).svc.snapshot(NOW);
    expect(byId(off, 'reasoning')).toMatchObject({ state: 'off', probed: true });
    expect(byId(off, 'reasoning').error).toBeUndefined(); // off is not loud
  });

  it('no gateway to probe means off, unprobed — a bare root is not degraded', async () => {
    const snapshot = await service(config({ modelProviders: reasoningProviders })).snapshot(NOW);
    expect(byId(snapshot, 'reasoning')).toMatchObject({ state: 'off', probed: false });
  });

  it('the reasoning probe runs BEFORE the vision probe, so headroom is armed first', async () => {
    const { svc, order } = probedService(true);
    await svc.snapshot(NOW);
    expect(order[0]).toBe('complete');
    expect(order).toContain('describeImage');
  });

  it('keeps its own longer cache: snapshots re-probe vision but not reasoning', async () => {
    const { svc, completeCalls } = probedService(true);
    await svc.snapshot(NOW);
    expect(completeCalls()).toBe(1);

    // Past the snapshot TTL, within the reasoning TTL: everything else
    // re-probes; the reasoning completion does not re-run.
    await svc.snapshot(new Date(NOW.getTime() + CAPABILITY_CACHE_TTL_MS + 1000));
    await svc.settle();
    expect(completeCalls()).toBe(1);

    await svc.snapshot(new Date(NOW.getTime() + REASONING_PROBE_TTL_MS + 1000));
    await svc.settle();
    expect(completeCalls()).toBe(2);
  });

  it('the vision probe keeps its own cache too (issue #418): one image per window', async () => {
    const { svc, order } = probedService(true);
    const visionProbes = () => order.filter((call) => call === 'describeImage').length;
    await svc.snapshot(NOW);
    expect(visionProbes()).toBe(1);

    // Past the snapshot TTL, within the vision TTL: no new image is sent.
    await svc.snapshot(new Date(NOW.getTime() + CAPABILITY_CACHE_TTL_MS + 1000));
    await svc.settle();
    expect(visionProbes()).toBe(1);

    // Past the vision TTL: the next pass probes with a real image again.
    await svc.snapshot(new Date(NOW.getTime() + VISION_PROBE_TTL_MS + 1000));
    await svc.settle();
    expect(visionProbes()).toBe(2);
  });

  it('the banner states it like every other capability', async () => {
    const snapshot = await probedService(true).svc.snapshot(NOW);
    expect(formatCapabilitiesBanner(snapshot, NOW)).toContain('reasoning ON (healthy)');
  });
});

describe('probe_cached', () => {
  it('repeated reads within the cache window hit the cache; a read past it re-probes', async () => {
    const calls = stubFetch(() => ({ status: 200 }));
    const svc = service(config({ redactionEnabled: true, composeProfiles: ['research'] }));

    await svc.snapshot(NOW);
    const probesAfterFirst = calls.length;
    expect(probesAfterFirst).toBeGreaterThan(0);

    await svc.snapshot(new Date(NOW.getTime() + CAPABILITY_CACHE_TTL_MS - 1000));
    expect(calls.length).toBe(probesAfterFirst); // served from cache

    // Past the TTL the stale snapshot is served INSTANTLY (issue #418) and one
    // background pass re-probes; settle() is the deterministic wait for it.
    await svc.snapshot(new Date(NOW.getTime() + CAPABILITY_CACHE_TTL_MS + 1000));
    await svc.settle();
    expect(calls.length).toBe(probesAfterFirst * 2); // TTL passed → probed again
  });

  it('stale-while-revalidate: a stale read serves the old snapshot and one refresh runs behind', async () => {
    stubFetch(() => ({ status: 200 }));
    const svc = service(config({ redactionEnabled: true }));
    const first = await svc.snapshot(NOW);

    const staleAt = new Date(NOW.getTime() + CAPABILITY_CACHE_TTL_MS + 1000);
    const [servedA, servedB] = await Promise.all([svc.snapshot(staleAt), svc.snapshot(staleAt)]);
    // Both stale reads got the OLD snapshot without waiting for probes.
    expect(servedA).toBe(first);
    expect(servedB).toBe(first);

    await svc.settle();
    const refreshed = await svc.snapshot(staleAt);
    expect(refreshed).not.toBe(first);
    expect(refreshed.capabilities[0]!.checkedAt).toBe(staleAt.toISOString());
  });
});

describe('banner_accurate', () => {
  it('states every capability and both jobs, exactly as the registry reports them', async () => {
    stubFetch((url) => (url.includes('searxng') ? 'refuse' : { status: 200 }));
    const snapshot = await service(
      config({
        redactionEnabled: true,
        composeProfiles: ['research'],
        modelProviders: ollamaProviders,
      }),
    ).snapshot(NOW);
    const banner = formatCapabilitiesBanner(snapshot, NOW);
    expect(banner).toContain('redaction ON (healthy)');
    expect(banner).toContain('research ON (UNREACHABLE)');
    expect(banner).toContain('demo OFF');
    expect(banner).toContain('consoles OFF');
    expect(banner).toContain('local-models ON (healthy)');
    expect(banner).toContain('dreaming last ran 6h ago');
    expect(banner).toContain('sweep last ran 7h ago');
  });

  it('a never-ran job and an overdue job are stated plainly', async () => {
    stubFetch(() => ({ status: 200 }));
    const sources: CapabilityJobSources = {
      dreaming: async () => ({
        lastFinishedAt: null,
        lastCounts: null,
        newestStartedAt: null,
        newestUnfinished: false,
      }),
      sweep: async () => ({
        lastSweepAt: new Date(NOW.getTime() - 30 * HOUR).toISOString(),
        lastReport: null,
        openAlerts: 0,
      }),
      installedAt: async () => new Date(NOW.getTime() - 1 * HOUR),
    };
    const snapshot = await service(config(), sources).snapshot(NOW);
    const banner = formatCapabilitiesBanner(snapshot, NOW);
    expect(banner).toContain('dreaming never ran');
    expect(banner).toContain('sweep last ran 30h ago (OVERDUE)');
  });
});
