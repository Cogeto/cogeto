import { ModelGateway } from './model-gateway.service';
import { MistralModelGateway, UnconfiguredModelGateway } from './mistral.gateway';
import { OpenAiCompatibleModelGateway } from './openai.gateway';
import { AnthropicModelGateway } from './anthropic.gateway';
import { TierRoutedModelGateway } from './routed.gateway';
import { RedactingModelGateway } from './redacting.gateway';
import { RedactionClient } from './redaction-client';
import { BudgetedModelGateway } from './budgeted.gateway';
import type { ModelProviderId, ResolvedModelProviders } from './provider-config';
import type { ModelUsageMeter } from '../infrastructure/index';

/**
 * Redaction wiring passed to the gateway factory (Addendum B.8). Enabled only on
 * the `redaction` profile; when off, the factory returns the underlying gateway
 * unchanged (byte-identical behavior — `redaction_off_noop`).
 */
export interface RedactionConfig {
  enabled: boolean;
  /** The sidecar base URL (compose sets it on the profile). */
  url: string;
  timeoutMs?: number;
}

export interface CreateModelGatewayOptions {
  /** The resolved per-tier provider configuration (decision 0040). Absent or
   * unconfigured → the process boots; model calls fail with a typed error. */
  providers?: ResolvedModelProviders;
  /** Sampling temperature for free-text completions (decision 0035); the eval
   * harness pins 0, production leaves unset. Providers that reject sampling
   * parameters (Anthropic) ignore it — 0040 ruling 1. */
  temperature?: number;
  redaction?: RedactionConfig;
  /**
   * Per-user daily model budget (FIX-2 QS-2). When present, the gateway is
   * wrapped so user-attributed calls are capped and metered; absent (eval,
   * smokes) leaves all calls unmetered.
   */
  usageMeter?: ModelUsageMeter;
}

/**
 * The single construction point for the model gateway (§A.10). Every process —
 * the DI module AND the bare entrypoints (eval, dream, reindex, …) — builds the
 * gateway here, so the redaction and budget decorators wrap ALL model traffic
 * uniformly and nothing can bypass them — for EVERY provider (decision 0040:
 * `redaction_applies_all_providers`, `budget_applies_all_providers`).
 *
 * Decorator order (outermost first): budget → redaction → provider(s). The
 * budget gate runs before any provider call and counts real model traffic;
 * redaction pseudonymizes inside it.
 */
export function createModelGateway(options: CreateModelGatewayOptions): ModelGateway {
  let gateway = buildProviderGateway(options.providers, options.temperature);

  if (options.redaction?.enabled) {
    gateway = new RedactingModelGateway(
      gateway,
      new RedactionClient(options.redaction.url, options.redaction.timeoutMs),
    );
  }
  if (options.usageMeter) {
    gateway = new BudgetedModelGateway(gateway, options.usageMeter);
  }
  return gateway;
}

/**
 * One adapter instance per DISTINCT provider, each given only the tier models
 * routed to it; a single-provider configuration (mistral-default included)
 * returns its adapter directly — byte-identical to the v1 path.
 */
function buildProviderGateway(
  providers: ResolvedModelProviders | undefined,
  temperature: number | undefined,
): ModelGateway {
  if (!providers || !providers.configured) return new UnconfiguredModelGateway();

  const { tiers, keys, endpoints } = providers;
  const adapters = new Map<ModelProviderId, ModelGateway>();
  const adapterFor = (provider: ModelProviderId): ModelGateway => {
    const existing = adapters.get(provider);
    if (existing) return existing;
    const modelIf = (tier: 'pipeline' | 'answer' | 'embedding'): string | undefined =>
      tiers[tier].provider === provider ? tiers[tier].model : undefined;
    // The resolver already refused any referenced provider without a key
    // (0040 ruling 3) — the assertion here is a belt for hand-built configs.
    const key = keys[provider];
    if (!key) throw new Error(`model provider "${provider}" is selected but has no API key`);
    let adapter: ModelGateway;
    switch (provider) {
      case 'mistral':
        adapter = new MistralModelGateway({
          apiKey: key,
          pipelineModel: modelIf('pipeline'),
          answerModel: modelIf('answer'),
          embedModel: modelIf('embedding'),
          temperature,
        });
        break;
      case 'openai':
        adapter = new OpenAiCompatibleModelGateway({
          apiKey: key,
          baseUrl: endpoints.openaiBaseUrl,
          pipelineModel: modelIf('pipeline'),
          answerModel: modelIf('answer'),
          embedModel: modelIf('embedding'),
          temperature,
        });
        break;
      case 'anthropic':
        adapter = new AnthropicModelGateway({
          apiKey: key,
          baseUrl: endpoints.anthropicBaseUrl,
          pipelineModel: modelIf('pipeline'),
          answerModel: modelIf('answer'),
        });
        break;
      case 'ollama': {
        // The local flavor of the OpenAI-compatible adapter (decision 0041
        // ruling 1): same HTTP surface under <root>/v1, local knobs on top —
        // per-tier timeouts, the tags probe, the `ollama pull` 404 hint. The
        // resolver refused boot without the base URL; the belt mirrors the
        // key assertion above.
        const ollama = providers.ollama;
        if (!ollama) throw new Error('provider "ollama" is selected but has no base URL');
        adapter = new OpenAiCompatibleModelGateway({
          apiKey: key,
          baseUrl: `${ollama.baseUrl}/v1`,
          providerLabel: 'ollama',
          tierTimeoutsMs: ollama.timeoutsMs,
          localRuntime: { rootUrl: ollama.baseUrl },
          pipelineModel: modelIf('pipeline'),
          answerModel: modelIf('answer'),
          embedModel: modelIf('embedding'),
          temperature,
        });
        break;
      }
    }
    adapters.set(provider, adapter);
    return adapter;
  };

  const routes = {
    pipeline: adapterFor(tiers.pipeline.provider),
    answer: adapterFor(tiers.answer.provider),
    embedding: adapterFor(tiers.embedding.provider),
  };
  if (adapters.size === 1) return routes.pipeline;
  return new TierRoutedModelGateway(routes);
}
