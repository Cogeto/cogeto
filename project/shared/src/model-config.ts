/** Model provider configuration display (decision 0040; Settings surface). */

export type ModelProviderIdDto = 'mistral' | 'openai' | 'anthropic';

export interface ModelTierBindingDto {
  provider: ModelProviderIdDto;
  model: string;
}

/**
 * GET /api/settings/model-config — READ-ONLY: which providers and models this
 * instance actively uses per tier, under which configuration id (the trust
 * page's join key), and what leaves the instance. Keys are operator-set in the
 * instance environment and are NEVER present in this DTO.
 */
export interface ModelConfigDto {
  /** False → no provider key is set; model features are disabled. */
  configured: boolean;
  /** The stable configuration id (e.g. `mistral-default`), `unconfigured` when off. */
  configurationId: string;
  /** The matched preset name, or null for a custom tier mix. */
  preset: string | null;
  tiers: {
    pipeline: ModelTierBindingDto;
    answer: ModelTierBindingDto;
    embeddings: ModelTierBindingDto;
  };
  redactionEnabled: boolean;
  /** One plain sentence on what leaves the instance under this configuration. */
  externalCalls: string;
}
