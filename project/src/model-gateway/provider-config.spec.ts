import { describe, expect, it } from 'vitest';
import {
  deriveProvidersId,
  ModelProviderConfigError,
  PROVIDER_PRESETS,
  resolveModelProviders,
} from './provider-config';

/** Provider configuration resolution (decision 0040 ruling 3). */

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as NodeJS.ProcessEnv;
const resolve = (vars: Record<string, string>, redacted = false) =>
  resolveModelProviders(env(vars), { redacted });

describe('config_validation_matrix — every invalid combination fails boot with the right message', () => {
  it('unknown provider name names the variable and the valid set', () => {
    expect(() =>
      resolve({ COGETO_PROVIDER_ANSWER: 'gemini', COGETO_MISTRAL_API_KEY: 'k' }),
    ).toThrowError(
      /COGETO_PROVIDER_ANSWER="gemini" is not a known provider.*mistral \| openai \| anthropic/,
    );
  });

  it('unknown preset names the variable and the valid presets', () => {
    expect(() => resolve({ COGETO_PROVIDER_PRESET: 'gpt5-everything' })).toThrowError(
      /COGETO_PROVIDER_PRESET="gpt5-everything" is not a known preset.*mistral-default/,
    );
  });

  it('a selected provider without its key refuses boot, naming the key variable', () => {
    expect(() =>
      resolve({
        COGETO_PROVIDER_ANSWER: 'openai',
        COGETO_MODEL_ANSWER: 'gpt-4o',
        COGETO_MISTRAL_API_KEY: 'k',
      }),
    ).toThrowError(/provider "openai" is selected for answer but COGETO_OPENAI_API_KEY is not set/);
  });

  it('an explicit preset with a missing mistral key refuses boot (no silent unconfigured)', () => {
    expect(() => resolve({ COGETO_PROVIDER_PRESET: 'mistral-default' })).toThrowError(
      /provider "mistral" is selected for pipeline, answer, embedding but COGETO_MISTRAL_API_KEY is not set/,
    );
  });

  it('a non-mistral provider without a model names the model variable', () => {
    expect(() =>
      resolve({
        COGETO_PROVIDER_ANSWER: 'anthropic',
        COGETO_ANTHROPIC_API_KEY: 'k',
        COGETO_MISTRAL_API_KEY: 'k',
      }),
    ).toThrowError(
      /no model configured for the answer tier on provider "anthropic" — set COGETO_MODEL_ANSWER/,
    );
  });

  it('embeddings on a provider without an embeddings API refuses boot (anthropic)', () => {
    expect(() =>
      resolve({
        COGETO_PROVIDER_EMBEDDINGS: 'anthropic',
        COGETO_MODEL_EMBEDDINGS: 'claude-sonnet-4-6',
        COGETO_ANTHROPIC_API_KEY: 'k',
        COGETO_MISTRAL_API_KEY: 'k',
      }),
    ).toThrowError(/provider "anthropic" has no embeddings API.*COGETO_PROVIDER_EMBEDDINGS/);
    // The error is the typed configuration error, not a generic throw.
    try {
      resolve({
        COGETO_PROVIDER_EMBEDDINGS: 'anthropic',
        COGETO_MODEL_EMBEDDINGS: 'x',
        COGETO_ANTHROPIC_API_KEY: 'k',
        COGETO_MISTRAL_API_KEY: 'k',
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelProviderConfigError);
    }
  });

  it('v1 parity: nothing set at all boots UNCONFIGURED instead of refusing', () => {
    const providers = resolve({});
    expect(providers.configured).toBe(false);
    expect(providers.id).toBe('unconfigured');
    // The default tiers still resolve (embedding model feeds MemoryModule).
    expect(providers.tiers.embedding.model).toBe('mistral-embed');
  });

  it('v1 parity: legacy mistral model vars without a key still boot unconfigured', () => {
    const providers = resolve({ COGETO_MISTRAL_MODEL_ANSWER: 'mistral-large-latest' });
    expect(providers.configured).toBe(false);
  });

  it('a bare mistral key means exactly what it meant in v1: mistral-default', () => {
    const providers = resolve({ COGETO_MISTRAL_API_KEY: 'k' });
    expect(providers.configured).toBe(true);
    expect(providers.id).toBe('mistral-default');
    expect(providers.preset).toBe('mistral-default');
    expect(providers.tiers).toEqual(PROVIDER_PRESETS['mistral-default']);
  });

  it('legacy mistral model vars still override the mistral tiers (v1 behavior)', () => {
    const providers = resolve({
      COGETO_MISTRAL_API_KEY: 'k',
      COGETO_MISTRAL_MODEL_PIPELINE: 'mistral-large-latest',
    });
    expect(providers.tiers.pipeline.model).toBe('mistral-large-latest');
    expect(providers.tiers.answer.model).toBe('mistral-medium-latest');
  });

  it('a valid mixed configuration resolves: anthropic answers over mistral embeddings', () => {
    const providers = resolve({
      COGETO_PROVIDER_ANSWER: 'anthropic',
      COGETO_MODEL_ANSWER: 'claude-sonnet-4-6',
      COGETO_ANTHROPIC_API_KEY: 'ak',
      COGETO_MISTRAL_API_KEY: 'mk',
    });
    expect(providers.configured).toBe(true);
    expect(providers.tiers.answer).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
    expect(providers.tiers.pipeline.provider).toBe('mistral');
    expect(providers.tiers.embedding.provider).toBe('mistral');
    // Matches the anthropic-answer preset expansion → gets its name.
    expect(providers.id).toBe('anthropic-answer');
  });

  it('base URLs default and are overridable', () => {
    const defaults = resolve({ COGETO_MISTRAL_API_KEY: 'k' });
    expect(defaults.endpoints.openaiBaseUrl).toBe('https://api.openai.com/v1');
    expect(defaults.endpoints.anthropicBaseUrl).toBe('https://api.anthropic.com');
    const custom = resolve({
      COGETO_MISTRAL_API_KEY: 'k',
      COGETO_OPENAI_BASE_URL: 'http://ollama:11434/v1',
    });
    expect(custom.endpoints.openaiBaseUrl).toBe('http://ollama:11434/v1');
  });
});

describe('config_id_stable — same config yields same id; any tier change yields a new id', () => {
  const OPENAI = {
    COGETO_PROVIDER_PRESET: 'openai-default',
    COGETO_OPENAI_API_KEY: 'ok',
  };

  it('the same configuration always derives the same id', () => {
    expect(resolve(OPENAI).id).toBe(resolve(OPENAI).id);
    expect(resolve(OPENAI).id).toBe('openai-default');
  });

  it('every tier change changes the id', () => {
    const base = resolve(OPENAI).id;
    const modelChange = resolve({ ...OPENAI, COGETO_MODEL_ANSWER: 'gpt-4.1' }).id;
    const providerChange = resolve({
      ...OPENAI,
      COGETO_PROVIDER_EMBEDDINGS: 'mistral',
      COGETO_MODEL_EMBEDDINGS: 'mistral-embed',
      COGETO_MISTRAL_API_KEY: 'mk',
    }).id;
    expect(modelChange).not.toBe(base);
    expect(providerChange).not.toBe(base);
    expect(modelChange).not.toBe(providerChange);
  });

  it('a custom mix derives the documented per-tier form', () => {
    const id = resolve({ ...OPENAI, COGETO_MODEL_ANSWER: 'gpt-4.1' }).id;
    expect(id).toBe(
      'pipe-openai-gpt-4o-mini--ans-openai-gpt-4-1--emb-openai-text-embedding-3-small',
    );
    // Ids stay inside the published trust-score pattern (decision 0032).
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('redaction appends the existing -redacted suffix', () => {
    expect(resolve({ COGETO_MISTRAL_API_KEY: 'k' }, true).id).toBe('mistral-default-redacted');
  });

  it('deriveProvidersId is pure and preset-aware', () => {
    expect(deriveProvidersId(PROVIDER_PRESETS['mistral-default']!, false)).toBe('mistral-default');
    expect(deriveProvidersId(PROVIDER_PRESETS['anthropic-answer']!, true)).toBe(
      'anthropic-answer-redacted',
    );
  });
});
