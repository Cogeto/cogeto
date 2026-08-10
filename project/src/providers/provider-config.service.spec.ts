import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../infrastructure/index';
import { LiveModelConfiguration } from '../model-gateway/index';
import type { ResolvedModelProviders, TierBinding } from '../model-gateway/index';
import { ProviderConfigService } from './provider-config.service';
import type { ProvidersOptions } from './providers.options';

/**
 * The version watch (issue #494). `startWatching` existed from day one with
 * both composition roots passing `pollIntervalMs`, and nothing ever called
 * it: the app masked the gap by reloading on its own saves while the worker
 * kept using boot-time models until a restart. These tests pin the two facts
 * that closed it: the service starts its own watch at application bootstrap,
 * and the watch actually moves the live configuration when the version
 * column does.
 */

const binding = (model: string): TierBinding => ({
  provider: 'openai',
  model,
  endpoint: {
    id: 'ep',
    label: 'ep',
    baseUrl: 'http://gpu.lan:9000/v1',
    apiKey: 'k',
    selfHosted: true,
  },
});

function configuration(over: Partial<ResolvedModelProviders> = {}): ResolvedModelProviders {
  const tier = binding('ff711');
  return {
    configured: true,
    id: 'cfg-a',
    preset: null,
    tiers: { pipeline: tier, answer: tier, embedding: binding('bge-m3') },
    vision: null,
    keys: {},
    endpoints: { openaiBaseUrl: '', anthropicBaseUrl: '' },
    ollama: null,
    timeoutsMs: undefined,
    reasoningHeadroom: 4,
    openaiSelfHosted: true,
    redacted: false,
    source: 'database',
    version: 1,
    answerOptions: [],
    ...over,
  };
}

function serviceWith(live: LiveModelConfiguration, pollIntervalMs: number): ProviderConfigService {
  const options = {
    live,
    masterKey: null,
    redacted: false,
    reasoningHeadroom: 4,
    timeoutsMs: undefined,
    trustScoresDir: '/nonexistent',
    pollIntervalMs,
  } as unknown as ProvidersOptions;
  return new ProviderConfigService({} as Db, options);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('provider_config_version_watch', () => {
  it('bootstrap_starts_the_watch: the lifecycle hook passes the configured interval', () => {
    const service = serviceWith(new LiveModelConfiguration(configuration()), 30_000);
    const started = vi.spyOn(service, 'startWatching');
    service.onApplicationBootstrap();
    expect(started).toHaveBeenCalledWith(30_000);
    service.onModuleDestroy();
  });

  it('watch_moves_the_live_configuration: a bumped version reaches a process that made no request', async () => {
    vi.useFakeTimers();
    const live = new LiveModelConfiguration(configuration());
    const service = serviceWith(live, 1_000);

    // The store and resolver stand in for the database: version 1 then 2, and
    // the re-resolution the poll must trigger.
    let storedVersion = 1;
    (service as unknown as { store: { readVersion(): Promise<number> } }).store = {
      readVersion: async () => storedVersion,
    };
    const next = configuration({
      id: 'cfg-b',
      tiers: {
        pipeline: binding('gpt-5.6-terra'),
        answer: binding('ff711'),
        embedding: binding('bge-m3'),
      },
      version: 2,
    });
    (service as unknown as { resolveCurrent(): Promise<ResolvedModelProviders> }).resolveCurrent =
      async () => next;

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(live.current.id).toBe('cfg-a'); // unchanged version, unchanged config

    storedVersion = 2;
    await vi.advanceTimersByTimeAsync(1_100);
    expect(live.current.id).toBe('cfg-b');
    expect(live.current.tiers.pipeline.model).toBe('gpt-5.6-terra');
    service.onModuleDestroy();
  });

  it('a_non_positive_interval_never_polls: the reindex CLI passes 0', () => {
    vi.useFakeTimers();
    const service = serviceWith(new LiveModelConfiguration(configuration()), 0);
    service.onApplicationBootstrap();
    expect(vi.getTimerCount()).toBe(0);
    service.onModuleDestroy();
  });
});
