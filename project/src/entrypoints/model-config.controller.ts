import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import type { ModelConfigDto } from '@cogeto/shared';
import { BearerAuthGuard } from '../identity/index';
import { COGETO_CONFIG } from './config';
import type { CogetoConfig } from './config';

/**
 * GET /api/settings/model-config (decision 0040) — the READ-ONLY "Model
 * configuration" Settings section: the active configuration id, provider and
 * model per tier, redaction posture, and one plain sentence on what leaves the
 * instance. Display only — keys are operator-set in the instance environment
 * and are never captured, stored, or returned here. The DTO is built field by
 * field so no key material can ever leak into it.
 */
@Controller('settings/model-config')
@UseGuards(BearerAuthGuard)
export class ModelConfigController {
  constructor(@Inject(COGETO_CONFIG) private readonly config: CogetoConfig) {}

  @Get()
  get(): ModelConfigDto {
    return buildModelConfigDto(this.config);
  }
}

const PROVIDER_LABEL: Record<string, string> = {
  mistral: 'Mistral',
  openai: 'the configured OpenAI-compatible endpoint',
  anthropic: 'Anthropic',
};

/** Pure DTO assembly — `settings_display_accurate` asserts it mirrors the
 * running configuration truthfully and carries no key material. */
export function buildModelConfigDto(
  config: Pick<CogetoConfig, 'modelProviders' | 'redactionEnabled'>,
): ModelConfigDto {
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
    };
  }
  const providers = [
    ...new Set(
      [p.tiers.pipeline.provider, p.tiers.answer.provider, p.tiers.embedding.provider].map(
        (id) => PROVIDER_LABEL[id] ?? id,
      ),
    ),
  ];
  const providerList =
    providers.length === 1
      ? providers[0]!
      : `${providers.slice(0, -1).join(', ')} and ${providers[providers.length - 1]!}`;
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
  };
}
