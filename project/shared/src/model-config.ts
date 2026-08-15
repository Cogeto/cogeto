/** Model provider configuration display (Settings surface). */

export type ModelProviderIdDto = 'mistral' | 'openai' | 'anthropic' | 'ollama';

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
  /**
   * One plain sentence on what leaves the instance under this configuration,
   * in English. It stays because it is the DTO's long-standing contract and
   * the fallback the interface renders for a `kind` it does not know.
   */
  externalCalls: string;
  /**
   * WHICH sentence, so the interface can write it in the reader's language
   * (F13). The same rule as a coded error: the server names the case and
   * supplies the values; the words are the interface's.
   */
  externalCallsKind: ExternalCallsKind;
  /** The providers named in that sentence, as ids the interface labels itself. */
  externalCallsProviders: ModelProviderIdDto[];
}

/** The four things there are to say about what leaves the instance. */
export type ExternalCallsKind = 'unconfigured' | 'all_local' | 'redacted' | 'external';
