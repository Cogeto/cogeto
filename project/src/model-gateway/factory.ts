import { ModelGateway } from './model-gateway.service';
import { MistralModelGateway, UnconfiguredModelGateway } from './mistral.gateway';
import { OpenAiCompatibleModelGateway } from './openai.gateway';
import { AnthropicModelGateway } from './anthropic.gateway';
import { TierRoutedModelGateway } from './routed.gateway';
import { RedactingModelGateway } from './redacting.gateway';
import { RedactionClient } from './redaction-client';
import { BudgetedModelGateway } from './budgeted.gateway';
import { AuditedModelGateway } from './audited.gateway';
import type { ModelProviderId, ResolvedModelProviders } from './provider-config';
import type { ModelEgressAudit, ModelUsageMeter } from '../infrastructure/index';

/**
 * Redaction wiring passed to the gateway factory (spec §12.2). Enabled only on
 * the `redaction` profile; when off, the factory returns the underlying gateway
 * unchanged (byte-identical behavior`redaction_off_noop`).
 */
export interface RedactionConfig {
  enabled: boolean;
  /** The sidecar base URL (compose sets it on the profile). */
  url: string;
  timeoutMs?: number;
}

export interface CreateModelGatewayOptions {
  /** The resolved per-tier provider configuration. Absent or
   * unconfigured → the process boots; model calls fail with a typed error. */
  providers?: ResolvedModelProviders;
  /** Sampling temperature for free-text completions; the eval
   * harness pins 0, production leaves unset. Providers that reject sampling
   * parameters (Anthropic) ignore it — 0040 ruling 1. */
  temperature?: number;
  redaction?: RedactionConfig;
  /**
   * Per-user daily model budget. When present, the gateway is
   * wrapped so user-attributed calls are capped and metered; absent (eval,
   * smokes) leaves all calls unmetered.
   */
  usageMeter?: ModelUsageMeter;
  /**
   * Append-only record of every call that leaves the instance (V2.0 item 3.7).
   * When present the gateway is wrapped so each call writes one structural
   * entry; absent (eval, smokes, bare harnesses) nothing is recorded, which is
   * why an eval run cannot flood the trail.
   */
  egressAudit?: ModelEgressAudit;
}

/**
 * The single construction point for the model gateway (spec §12.1). Every process —
 * the DI module AND the bare entrypoints (eval, dream, reindex, …) — builds the
 * gateway here, so the redaction and budget decorators wrap ALL model traffic
 * uniformly and nothing can bypass them — for EVERY provider (
 * `redaction_applies_all_providers`, `budget_applies_all_providers`).
 *
 * Decorator order (outermost first): audit → budget → redaction → provider(s).
 * The budget gate runs before any provider call and counts real model traffic;
 * redaction pseudonymizes inside it. The audit sits OUTSIDE the budget so a
 * refused call is never recorded as egress — nothing left the box — and its
 * latency covers what the caller actually waited for.
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
  if (options.egressAudit) {
    gateway = new AuditedModelGateway(
      gateway,
      options.egressAudit,
      routesOf(options.providers),
      options.redaction?.enabled ?? false,
    );
  }
  return gateway;
}

/**
 * Tier → provider + resolved model, so an egress entry names where the bytes
 * went without the decorator knowing anything about adapters. Empty when the
 * gateway is unconfigured; the entry then records nulls, which is the truth.
 */
function routesOf(
  providers: ResolvedModelProviders | undefined,
): Record<string, { provider: string; model: string }> {
  if (!providers?.configured) return {};
  const { tiers } = providers;
  return {
    pipeline: { provider: tiers.pipeline.provider, model: tiers.pipeline.model },
    answer: { provider: tiers.answer.provider, model: tiers.answer.model },
    embedding: { provider: tiers.embedding.provider, model: tiers.embedding.model },
    // Vision egress is audited under its own route name, so "an image left the
    // box" is distinguishable in the trail from "a sentence did".
    ...(providers.vision
      ? { vision: { provider: providers.vision.provider, model: providers.vision.model } }
      : {}),
  };
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
    const visionModel =
      providers.vision?.provider === provider ? providers.vision.model : undefined;
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
          // Timeouts apply to a SELF-HOSTED endpoint only. A model on your own
          // hardware answers in seconds to minutes, and until now nothing
          // bounded those calls at all unless the provider happened to be
          // Ollama; hosted OpenAI keeps its historical no-timeout behaviour.
          ...(providers.openaiSelfHosted ? { tierTimeoutsMs: providers.timeoutsMs } : {}),
          pipelineModel: modelIf('pipeline'),
          answerModel: modelIf('answer'),
          embedModel: modelIf('embedding'),
          visionModel,
          temperature,
          reasoningHeadroom: providers.reasoningHeadroom,
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
        // The local flavor of the OpenAI-compatible adapter (
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
          tierTimeoutsMs: providers.timeoutsMs,
          localRuntime: { rootUrl: ollama.baseUrl },
          pipelineModel: modelIf('pipeline'),
          answerModel: modelIf('answer'),
          embedModel: modelIf('embedding'),
          visionModel,
          temperature,
          reasoningHeadroom: providers.reasoningHeadroom,
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
    vision: providers.vision ? adapterFor(providers.vision.provider) : null,
  };
  // A single-provider configuration returns its adapter directly, byte-identical
  // to the path before tiers existed — but only when there is no vision binding
  // to route, because the adapter itself cannot say "no vision configured" for
  // a provider that simply has no image model.
  if (adapters.size === 1 && !providers.vision) return routes.pipeline;
  return new TierRoutedModelGateway(routes);
}
