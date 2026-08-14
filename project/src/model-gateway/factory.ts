import { ModelGateway } from './model-gateway.service';
import { MistralModelGateway, UnconfiguredModelGateway } from './mistral.gateway';
import { OpenAiCompatibleModelGateway } from './openai.gateway';
import { AnthropicModelGateway } from './anthropic.gateway';
import { TierRoutedModelGateway } from './routed.gateway';
import { RedactingModelGateway } from './redacting.gateway';
import { RedactionClient } from './redaction-client';
import { BudgetedModelGateway } from './budgeted.gateway';
import { AuditedModelGateway } from './audited.gateway';
import type { ResolvedModelProviders, TierBinding } from './provider-config';
import type { LiveModelConfiguration } from './live-configuration';
import { ReloadingModelGateway } from './reloading.gateway';
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
  /**
   * The live configuration (V2.4 item 7.1). When present, the provider stack is
   * rebuilt whenever its version changes, so an admin saving an assignment
   * takes effect on the next call instead of the next restart. When absent the
   * gateway is built exactly once, which is what the eval harness and every
   * bare entrypoint want.
   */
  live?: LiveModelConfiguration;
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
  const build = (providers: ResolvedModelProviders | undefined): ModelGateway => {
    let gateway = buildProviderGateway(providers, options.temperature);

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
        routesOf(providers),
        options.redaction?.enabled ?? false,
      );
    }
    return gateway;
  };

  // The live configuration wins when both are given: `providers` is then the
  // same object the holder owns, and the holder is the one that knows when it
  // changed. Every decorator is rebuilt with the stack, so a reloaded gateway
  // is wrapped exactly like the one it replaced (`redaction_applies_all_providers`).
  const live = options.live;
  if (live) return new ReloadingModelGateway(live, build);
  return build(options.providers);
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
    // One route per user-selectable answer model (V2.4 item 7.1): when a user
    // answers on their own choice, the trail must name the model that actually
    // received the bytes, not the tier's assigned default.
    ...Object.fromEntries(
      providers.answerOptions.map((option) => [
        `answer:${option.id}`,
        { provider: option.binding.provider, model: option.binding.model },
      ]),
    ),
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
  const adapters = new Map<string, ModelGateway>();
  /**
   * The adapter cache key. Without provider records it is the provider id, the
   * shape this had while one instance had one endpoint and one key per
   * provider. With them (V2.4 item 7.1) it is the record's id plus the models
   * the binding needs, because two records of the same type are two different
   * endpoints with two different credentials and must never share an adapter.
   */
  const adapterFor = (binding: TierBinding, role: 'tier' | 'answerOption'): ModelGateway => {
    const provider = binding.provider;
    const endpoint = binding.endpoint;
    const cacheKey = endpoint
      ? `${endpoint.id}:${role === 'answerOption' ? `answer=${binding.model}` : 'tiers'}`
      : provider;
    const existing = adapters.get(cacheKey);
    if (existing) return existing;
    /**
     * Which model this adapter serves for a tier. An adapter built for ONE
     * user-selectable answer option serves that model on the answer tier and
     * nothing else; a tier adapter serves every tier routed to the same
     * endpoint, which is what keeps a single-provider instance on one adapter.
     */
    const modelIf = (tier: 'pipeline' | 'answer' | 'embedding'): string | undefined => {
      if (role === 'answerOption') return tier === 'answer' ? binding.model : undefined;
      const candidate = tiers[tier];
      if (candidate.provider !== provider) return undefined;
      if ((candidate.endpoint?.id ?? null) !== (endpoint?.id ?? null)) return undefined;
      return candidate.model;
    };
    const visionModel =
      role === 'tier' &&
      providers.vision?.provider === provider &&
      (providers.vision.endpoint?.id ?? null) === (endpoint?.id ?? null)
        ? providers.vision.model
        : undefined;
    // The resolver already refused any referenced provider without a key
    // (0040 ruling 3) — the assertion here is a belt for hand-built configs.
    const key = endpoint?.apiKey ?? keys[provider];
    if (!key) throw new Error(`model provider "${provider}" is selected but has no API key`);
    const baseUrl = endpoint?.baseUrl;
    const selfHosted = endpoint ? endpoint.selfHosted : providers.openaiSelfHosted;
    let adapter: ModelGateway;
    switch (provider) {
      case 'mistral':
        adapter = new MistralModelGateway({
          apiKey: key,
          pipelineModel: modelIf('pipeline'),
          answerModel: modelIf('answer'),
          embedModel: modelIf('embedding'),
          // Issue #570: this was computed above and handed to the OpenAI and
          // Ollama cases only, so a Mistral vision binding built an adapter
          // that could not see and reported itself unconfigured.
          visionModel,
          // Issue #573: a Magistral binding spends part of its cap thinking,
          // so the same headroom the OpenAI-compatible adapter applies is
          // applied here rather than truncating the answer away.
          reasoningHeadroom: providers.reasoningHeadroom,
          temperature,
        });
        break;
      case 'openai':
        adapter = new OpenAiCompatibleModelGateway({
          apiKey: key,
          // The provider record's endpoint when there is one (V2.4 item 7.1),
          // else the instance-wide one the environment shape resolved.
          baseUrl: baseUrl ?? endpoints.openaiBaseUrl,
          // Timeouts apply to a SELF-HOSTED endpoint only. A model on your own
          // hardware answers in seconds to minutes, and until now nothing
          // bounded those calls at all unless the provider happened to be
          // Ollama; hosted OpenAI keeps its historical no-timeout behaviour.
          ...(selfHosted ? { tierTimeoutsMs: providers.timeoutsMs } : {}),
          pipelineModel: modelIf('pipeline'),
          answerModel: modelIf('answer'),
          embedModel: modelIf('embedding'),
          visionModel,
          temperature,
          reasoningHeadroom: providers.reasoningHeadroom,
          // Per-request thinking control (issue #424): self-hosted only — the
          // hosted API rejects unknown parameters.
          thinkingControl: selfHosted,
        });
        break;
      case 'anthropic':
        adapter = new AnthropicModelGateway({
          apiKey: key,
          baseUrl: baseUrl ?? endpoints.anthropicBaseUrl,
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
        // A provider record carries its own runtime root (V2.4 item 7.1); the
        // environment shape carries the instance-wide one.
        const rootUrl = endpoint
          ? endpoint.baseUrl.replace(/\/v1$/, '')
          : providers.ollama?.baseUrl;
        if (!rootUrl) throw new Error('provider "ollama" is selected but has no base URL');
        adapter = new OpenAiCompatibleModelGateway({
          apiKey: key,
          baseUrl: `${rootUrl}/v1`,
          providerLabel: 'ollama',
          tierTimeoutsMs: providers.timeoutsMs,
          localRuntime: { rootUrl },
          pipelineModel: modelIf('pipeline'),
          answerModel: modelIf('answer'),
          embedModel: modelIf('embedding'),
          visionModel,
          temperature,
          reasoningHeadroom: providers.reasoningHeadroom,
          // The local runtime is always ours to control (issue #424).
          thinkingControl: true,
        });
        break;
      }
    }
    adapters.set(cacheKey, adapter);
    return adapter;
  };

  const answerOptions = new Map<string, ModelGateway>();
  for (const option of providers.answerOptions) {
    answerOptions.set(option.id, adapterFor(option.binding, 'answerOption'));
  }
  const routes = {
    pipeline: adapterFor(tiers.pipeline, 'tier'),
    answer: adapterFor(tiers.answer, 'tier'),
    embedding: adapterFor(tiers.embedding, 'tier'),
    vision: providers.vision ? adapterFor(providers.vision, 'tier') : null,
    answerOptions,
  };
  // A single-provider configuration returns its adapter directly, byte-identical
  // to the path before tiers existed — but only when there is no vision binding
  // to route, because the adapter itself cannot say "no vision configured" for
  // a provider that simply has no image model, and no user-selectable answer
  // option to route either (V2.4 item 7.1).
  if (adapters.size === 1 && !providers.vision && answerOptions.size === 0) return routes.pipeline;
  return new TierRoutedModelGateway(routes);
}
