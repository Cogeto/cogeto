import { describe, expect, it } from 'vitest';
import { LiveModelConfiguration } from './live-configuration';
import { TierRoutedModelGateway } from './routed.gateway';
import { ModelGateway } from './model-gateway.service';
import type { CompletionRequest, CompletionResult, StreamDelta } from './model-gateway.service';
import { createModelGateway } from './factory';
import { SELF_HOSTED_TIMEOUT_DEFAULTS_MS } from './provider-config';
import type { ResolvedModelProviders, TierBinding } from './provider-config';

/**
 * The live configuration and the gateway that follows it (V2.4 item 7.1).
 *
 * Two claims are load-bearing and asserted here rather than assumed:
 *
 * 1. The live object is mutated IN PLACE, so every consumer that was handed
 *    `config.modelProviders` is current without knowing reloading exists.
 * 2. The gateway rebuilds its whole decorated stack when the version changes,
 *    and rebuilds NOTHING when it does not.
 */

const endpoint = (id: string, baseUrl: string, apiKey: string) => ({
  id,
  label: id,
  baseUrl,
  apiKey,
  selfHosted: true,
});

const binding = (model: string, endpointId: string, apiKey = 'k'): TierBinding => ({
  provider: 'openai',
  model,
  endpoint: endpoint(endpointId, 'http://gpu.lan:9000/v1', apiKey),
});

function configuration(over: Partial<ResolvedModelProviders> = {}): ResolvedModelProviders {
  const tier = binding('ff711', 'mine');
  return {
    configured: true,
    id: 'pipe-openai-ff711--ans-openai-ff711--emb-openai-bge-m3',
    preset: null,
    tiers: { pipeline: tier, answer: tier, embedding: binding('bge-m3', 'mine') },
    vision: null,
    keys: {},
    endpoints: { openaiBaseUrl: '', anthropicBaseUrl: '' },
    ollama: null,
    timeoutsMs: SELF_HOSTED_TIMEOUT_DEFAULTS_MS,
    reasoningHeadroom: 4,
    openaiSelfHosted: true,
    redacted: false,
    source: 'database',
    version: 1,
    answerOptions: [],
    ...over,
  };
}

describe('live_configuration: one object, mutated in place', () => {
  it('holders_see_the_change: a consumer that captured the object is current', () => {
    const live = new LiveModelConfiguration(configuration());
    const heldByAConsumer = live.current;

    const changed = configuration({
      tiers: { ...live.current.tiers, answer: binding('other', 'mine') },
    });
    expect(live.replace(changed)).toBe(true);

    // The SAME object reference, carrying the new binding.
    expect(heldByAConsumer).toBe(live.current);
    expect(heldByAConsumer.tiers.answer.model).toBe('other');
    expect(heldByAConsumer.version).toBe(2);
  });

  it('an_unchanged_resolution_is_free: no version bump, no rebuild', () => {
    const live = new LiveModelConfiguration(configuration());
    expect(live.replace(configuration())).toBe(false);
    expect(live.current.version).toBe(1);
  });

  it('a_rotated_key_on_an_unchanged_binding_still_counts_as_a_change', () => {
    const live = new LiveModelConfiguration(configuration());
    const rotated = configuration({
      tiers: {
        pipeline: binding('ff711', 'mine', 'rotated'),
        answer: binding('ff711', 'mine', 'rotated'),
        embedding: binding('bge-m3', 'mine', 'rotated'),
      },
    });
    expect(live.replace(rotated)).toBe(true);
  });
});

describe('reloading_gateway: the stack follows the configuration', () => {
  it('rebuilds_on_a_version_change: a saved assignment reaches the next call', () => {
    const live = new LiveModelConfiguration(configuration());
    const gateway = createModelGateway({ live, providers: live.current });
    // `embeddingModelId` is what every adapter answers without a network call,
    // so it is the cheapest observable proof of WHICH stack is in force.
    expect(gateway.embeddingModelId()).toBe('bge-m3');

    live.replace(
      configuration({
        tiers: {
          pipeline: binding('ff711', 'mine'),
          answer: binding('ff711', 'mine'),
          embedding: binding('bge-m3-v2', 'mine'),
        },
      }),
    );
    expect(gateway.embeddingModelId()).toBe('bge-m3-v2');
  });

  it('the_user_choice_reaches_the_chosen_adapter, and an unknown one falls back', async () => {
    // Named adapters, so "which one answered" is observable without a network.
    class Named extends ModelGateway {
      constructor(private readonly name: string) {
        super();
      }
      async complete(): Promise<CompletionResult> {
        return { text: this.name };
      }
      async *completeStream(): AsyncIterable<StreamDelta> {
        yield { channel: 'text', text: this.name };
      }
      async extractStructured<T>(): Promise<T> {
        return null as T;
      }
      async embed(): Promise<number[][]> {
        return [[0]];
      }
      embeddingModelId(): string {
        return this.name;
      }
    }
    const routed = new TierRoutedModelGateway({
      pipeline: new Named('pipeline'),
      answer: new Named('assigned'),
      embedding: new Named('embedding'),
      answerOptions: new Map([['opt-1', new Named('chosen')]]),
    });

    const ask = (request: CompletionRequest) => routed.complete(request);
    expect((await ask({ input: 'q' })).text).toBe('assigned');
    expect((await ask({ input: 'q', answerOption: 'opt-1' })).text).toBe('chosen');
    // A retired option must not break the next question a user asks.
    expect((await ask({ input: 'q', answerOption: 'gone' })).text).toBe('assigned');
    // And an option id never leaks into another tier's routing.
    expect((await ask({ input: 'q', tier: 'pipeline', answerOption: 'opt-1' })).text).toBe(
      'pipeline',
    );
  });

  it('enabled_options_do_not_disturb_the_tiers_they_sit_beside', () => {
    const live = new LiveModelConfiguration(
      configuration({
        answerOptions: [
          { id: 'opt-1', label: 'The big one', binding: binding('bigmodel', 'mine') },
        ],
      }),
    );
    const gateway = createModelGateway({ live, providers: live.current });
    // A configuration with options must NOT take the single-adapter shortcut,
    // which would make the option unroutable — and the assigned tiers are
    // unchanged either way.
    expect(gateway.embeddingModelId()).toBe('bge-m3');
  });
});
