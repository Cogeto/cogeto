import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import type { ModelConfigDto } from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import { MODEL_CONFIG_VIEW } from './model-config-view';
import type { ModelConfigView } from './model-config-view';

/**
 * GET /api/settings/model-config — the READ-ONLY "Model
 * configuration" Settings section: the active configuration id, provider and
 * model per tier, redaction posture, and one plain sentence on what leaves the
 * instance. Display only — keys are operator-set in the instance environment
 * and are never captured, stored, or returned here. The DTO is built field by
 * field so no key material can ever leak into it.
 */
@Controller('settings/model-config')
@UseGuards(BearerAuthGuard)
export class ModelConfigController {
  constructor(@Inject(MODEL_CONFIG_VIEW) private readonly config: ModelConfigView) {}

  @Get()
  get(): ModelConfigDto {
    return buildModelConfigDto(this.config);
  }
}

const PROVIDER_LABEL: Record<string, string> = {
  mistral: 'Mistral',
  openai: 'the configured OpenAI-compatible endpoint',
  anthropic: 'Anthropic',
  ollama: 'the local Ollama runtime',
};

/** Pure DTO assembly`settings_display_accurate` asserts it mirrors the
 * running configuration truthfully and carries no key material. */
export function buildModelConfigDto(config: ModelConfigView): ModelConfigDto {
  const p = config.modelProviders;
  if (!p.configured) {
    return {
      configured: false,
      configurationId: p.id,
      preset: null,
      tiers: {
        pipeline: { provider: p.tiers.pipeline.provider, model: p.tiers.pipeline.model },
        answer: { provider: p.tiers.answer.provider, model: p.tiers.answer.model },
        embeddings: { provider: p.tiers.embedding.provider, model: p.tiers.embedding.model },
      },
      redactionEnabled: config.redactionEnabled,
      externalCalls:
        'No model provider is configured, so nothing leaves this instance for model calls; model features are disabled.',
      externalCallsKind: 'unconfigured',
      externalCallsProviders: [],
    };
  }
  // The ids, deduplicated in tier order, and the English labels beside them.
  // The interface labels the ids itself and joins them with its own language's
  // list rules; `externalCalls` below stays the English sentence it always was.
  const named = [
    ...new Set([p.tiers.pipeline.provider, p.tiers.answer.provider, p.tiers.embedding.provider]),
  ];
  const providers = named.map((id) => PROVIDER_LABEL[id] ?? id);
  const providerList =
    providers.length === 1
      ? providers[0]!
      : `${providers.slice(0, -1).join(', ')} and ${providers[providers.length - 1]!}`;
  // All-local: the honest sentence is that no hosted provider
  // receives anything — model calls stay on the operator's own network.
  const allLocal = [p.tiers.pipeline, p.tiers.answer, p.tiers.embedding].every(
    (tier) => tier.provider === 'ollama',
  );
  if (allLocal) {
    return {
      configured: true,
      configurationId: p.id,
      preset: p.preset,
      tiers: {
        pipeline: { provider: p.tiers.pipeline.provider, model: p.tiers.pipeline.model },
        answer: { provider: p.tiers.answer.provider, model: p.tiers.answer.model },
        embeddings: { provider: p.tiers.embedding.provider, model: p.tiers.embedding.model },
      },
      redactionEnabled: config.redactionEnabled,
      externalCalls:
        'Model calls (including embeddings) go to the local Ollama runtime on your own network; nothing is sent to a hosted model provider.',
      externalCallsKind: 'all_local',
      externalCallsProviders: [],
    };
  }
  const externalCalls = config.redactionEnabled
    ? `Model calls (including embeddings) go to ${providerList}; redaction pseudonymizes the text before it leaves this instance and fails closed if the sidecar is down.`
    : `Model calls (including embeddings) send text to ${providerList}; everything else stays inside this instance.`;
  return {
    configured: true,
    configurationId: p.id,
    preset: p.preset,
    tiers: {
      pipeline: { provider: p.tiers.pipeline.provider, model: p.tiers.pipeline.model },
      answer: { provider: p.tiers.answer.provider, model: p.tiers.answer.model },
      embeddings: { provider: p.tiers.embedding.provider, model: p.tiers.embedding.model },
    },
    redactionEnabled: config.redactionEnabled,
    externalCalls,
    externalCallsKind: config.redactionEnabled ? 'redacted' : 'external',
    externalCallsProviders: named,
  };
}
