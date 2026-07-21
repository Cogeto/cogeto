/**
 * Per-instance model provider configuration (decision 0040 ruling 3). One pure
 * resolver turns the environment into a validated, per-tier provider binding —
 * the SAME resolver for app, worker, bare entrypoints and the eval harness, so
 * the boot log, Settings and the trust-score emission can never disagree about
 * which configuration is active. Invalid configuration throws HERE, at boot,
 * never at first request.
 */

export type ModelProviderId = 'mistral' | 'openai' | 'anthropic';

export const MODEL_PROVIDER_IDS: readonly ModelProviderId[] = ['mistral', 'openai', 'anthropic'];

/** Providers with an embeddings API — Anthropic has none (ruling 3). */
export const EMBEDDING_CAPABLE: readonly ModelProviderId[] = ['mistral', 'openai'];

export interface TierBinding {
  provider: ModelProviderId;
  model: string;
}

export interface ResolvedModelProviders {
  /** False → the gateway boots unconfigured; model calls fail with a typed error. */
  configured: boolean;
  /** The configuration id — the trust page's join key; `unconfigured` when off. */
  id: string;
  /** The matched preset name, or null for a custom tier mix. */
  preset: string | null;
  tiers: { pipeline: TierBinding; answer: TierBinding; embedding: TierBinding };
  /** API keys per provider — never logged, stored, or serialized to any DTO. */
  keys: Partial<Record<ModelProviderId, string>>;
  endpoints: { openaiBaseUrl: string; anthropicBaseUrl: string };
  redacted: boolean;
}

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

type PresetTiers = ResolvedModelProviders['tiers'];

/**
 * The documented presets (.env.example): `mistral-default` is THE default and
 * exactly the v1 configuration; the others are convenient starting points an
 * operator overrides per tier as needed. Models here are defaults, not
 * endorsements — any tier var overrides them.
 */
export const PROVIDER_PRESETS: Record<string, PresetTiers> = {
  'mistral-default': {
    pipeline: { provider: 'mistral', model: 'mistral-small-latest' },
    answer: { provider: 'mistral', model: 'mistral-medium-latest' },
    embedding: { provider: 'mistral', model: 'mistral-embed' },
  },
  'openai-default': {
    pipeline: { provider: 'openai', model: 'gpt-4o-mini' },
    answer: { provider: 'openai', model: 'gpt-4o' },
    embedding: { provider: 'openai', model: 'text-embedding-3-small' },
  },
  // Anthropic for the user-facing answer tier; pipeline volume and embeddings
  // stay on Mistral (Anthropic exposes no embeddings API — ruling 3).
  'anthropic-answer': {
    pipeline: { provider: 'mistral', model: 'mistral-small-latest' },
    answer: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    embedding: { provider: 'mistral', model: 'mistral-embed' },
  },
};

const TIERS = ['pipeline', 'answer', 'embedding'] as const;
type TierName = (typeof TIERS)[number];

/** Env var suffix per tier — the operator-facing name says "embeddings". */
const TIER_SUFFIX: Record<TierName, string> = {
  pipeline: 'PIPELINE',
  answer: 'ANSWER',
  embedding: 'EMBEDDINGS',
};

const KEY_VAR: Record<ModelProviderId, string> = {
  mistral: 'COGETO_MISTRAL_API_KEY',
  openai: 'COGETO_OPENAI_API_KEY',
  anthropic: 'COGETO_ANTHROPIC_API_KEY',
};

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Deterministic configuration id (ruling 3): preset name on an exact match,
 * else the full per-tier derivation; `-redacted` suffix as before. */
export function deriveProvidersId(tiers: PresetTiers, redacted: boolean): string {
  const suffix = redacted ? '-redacted' : '';
  for (const [name, preset] of Object.entries(PROVIDER_PRESETS)) {
    if (
      TIERS.every(
        (tier) =>
          preset[tier].provider === tiers[tier].provider &&
          preset[tier].model === tiers[tier].model,
      )
    ) {
      return `${name}${suffix}`;
    }
  }
  return (
    `pipe-${tiers.pipeline.provider}-${slug(tiers.pipeline.model)}` +
    `--ans-${tiers.answer.provider}-${slug(tiers.answer.model)}` +
    `--emb-${tiers.embedding.provider}-${slug(tiers.embedding.model)}` +
    suffix
  );
}

export class ModelProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelProviderConfigError';
  }
}

/** Compose passes '' when unset; treat empty as absent. */
const read = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value ? value : undefined;
};

function parseProvider(name: string, value: string): ModelProviderId {
  if ((MODEL_PROVIDER_IDS as readonly string[]).includes(value)) return value as ModelProviderId;
  throw new ModelProviderConfigError(
    `${name}="${value}" is not a known provider — use one of: ${MODEL_PROVIDER_IDS.join(' | ')}`,
  );
}

/**
 * Resolve the instance's model provider configuration from the environment.
 * Precedence per tier: explicit COGETO_PROVIDER_x + COGETO_MODEL_x vars >
 * COGETO_PROVIDER_PRESET expansion > legacy COGETO_MISTRAL_MODEL_x vars >
 * the mistral-default preset. Throws ModelProviderConfigError with the exact
 * variable to fix on any invalid combination (boot-time, ruling 3).
 */
export function resolveModelProviders(
  env: NodeJS.ProcessEnv,
  options: { redacted: boolean },
): ResolvedModelProviders {
  const presetName = read(env, 'COGETO_PROVIDER_PRESET');
  if (presetName && !PROVIDER_PRESETS[presetName]) {
    throw new ModelProviderConfigError(
      `COGETO_PROVIDER_PRESET="${presetName}" is not a known preset — use one of: ${Object.keys(
        PROVIDER_PRESETS,
      ).join(' | ')}`,
    );
  }

  // Base: the chosen preset (default mistral-default), then the legacy
  // per-tier Mistral model vars keep meaning exactly what they meant in v1.
  const base = PROVIDER_PRESETS[presetName ?? 'mistral-default']!;
  const tiers: PresetTiers = {
    pipeline: { ...base.pipeline },
    answer: { ...base.answer },
    embedding: { ...base.embedding },
  };
  const legacyModels: Record<TierName, string | undefined> = {
    pipeline: read(env, 'COGETO_MISTRAL_MODEL_PIPELINE') ?? read(env, 'MISTRAL_MODEL_PIPELINE'),
    answer: read(env, 'COGETO_MISTRAL_MODEL_ANSWER') ?? read(env, 'MISTRAL_MODEL_ANSWER'),
    embedding: read(env, 'COGETO_MISTRAL_EMBED_MODEL') ?? read(env, 'MISTRAL_EMBED_MODEL'),
  };
  for (const tier of TIERS) {
    const legacy = legacyModels[tier];
    if (legacy && tiers[tier].provider === 'mistral') tiers[tier].model = legacy;
  }

  // Explicit per-tier overrides win. A provider switch discards the inherited
  // model — cross-provider model names are never mixed silently; mistral keeps
  // its v1 defaults, any other provider requires an explicit model.
  let explicit = presetName !== undefined;
  const explicitVars: Record<
    TierName,
    { provider: string | undefined; model: string | undefined }
  > = {
    pipeline: {
      provider: read(env, 'COGETO_PROVIDER_PIPELINE'),
      model: read(env, 'COGETO_MODEL_PIPELINE'),
    },
    answer: {
      provider: read(env, 'COGETO_PROVIDER_ANSWER'),
      model: read(env, 'COGETO_MODEL_ANSWER'),
    },
    embedding: {
      provider: read(env, 'COGETO_PROVIDER_EMBEDDINGS'),
      model: read(env, 'COGETO_MODEL_EMBEDDINGS'),
    },
  };
  for (const tier of TIERS) {
    const { provider: providerVar, model: modelVar } = explicitVars[tier];
    if (providerVar || modelVar) explicit = true;
    if (providerVar) {
      const provider = parseProvider(`COGETO_PROVIDER_${TIER_SUFFIX[tier]}`, providerVar);
      if (provider !== tiers[tier].provider) {
        const fallback =
          provider === 'mistral' ? PROVIDER_PRESETS['mistral-default']![tier].model : undefined;
        const model = modelVar ?? fallback;
        if (!model) {
          throw new ModelProviderConfigError(
            `no model configured for the ${tier} tier on provider "${provider}" — set COGETO_MODEL_${TIER_SUFFIX[tier]}`,
          );
        }
        tiers[tier] = { provider, model };
        continue;
      }
    }
    if (modelVar) tiers[tier].model = modelVar;
  }

  // Embeddings capability gate (ruling 3): fail at boot, never at first embed.
  if (!EMBEDDING_CAPABLE.includes(tiers.embedding.provider)) {
    throw new ModelProviderConfigError(
      `provider "${tiers.embedding.provider}" has no embeddings API — the embeddings tier must use ` +
        `one of: ${EMBEDDING_CAPABLE.join(' | ')} (set COGETO_PROVIDER_EMBEDDINGS)`,
    );
  }

  const keys: Partial<Record<ModelProviderId, string>> = {};
  const mistralKey = read(env, 'COGETO_MISTRAL_API_KEY') ?? read(env, 'MISTRAL_API_KEY');
  if (mistralKey) keys.mistral = mistralKey;
  const openaiKey = read(env, 'COGETO_OPENAI_API_KEY');
  if (openaiKey) keys.openai = openaiKey;
  const anthropicKey = read(env, 'COGETO_ANTHROPIC_API_KEY');
  if (anthropicKey) keys.anthropic = anthropicKey;

  const referenced = [...new Set(TIERS.map((tier) => tiers[tier].provider))];
  const missingKeys = referenced.filter((provider) => !keys[provider]);

  // v1 parity: a purely implicit mistral-default instance without a key boots
  // with model features off (typed error on use) instead of refusing.
  let configured = true;
  if (missingKeys.length > 0) {
    if (!explicit && referenced.length === 1 && referenced[0] === 'mistral') {
      configured = false;
    } else {
      const details = missingKeys
        .map(
          (provider) =>
            `provider "${provider}" is selected for ${TIERS.filter(
              (tier) => tiers[tier].provider === provider,
            ).join(', ')} but ${KEY_VAR[provider]} is not set`,
        )
        .join('; ');
      throw new ModelProviderConfigError(details);
    }
  }

  return {
    configured,
    id: configured ? deriveProvidersId(tiers, options.redacted) : 'unconfigured',
    preset: presetForTiers(tiers),
    tiers,
    keys,
    endpoints: {
      openaiBaseUrl: read(env, 'COGETO_OPENAI_BASE_URL') ?? DEFAULT_OPENAI_BASE_URL,
      anthropicBaseUrl: read(env, 'COGETO_ANTHROPIC_BASE_URL') ?? DEFAULT_ANTHROPIC_BASE_URL,
    },
    redacted: options.redacted,
  };
}

function presetForTiers(tiers: PresetTiers): string | null {
  for (const [name, preset] of Object.entries(PROVIDER_PRESETS)) {
    if (
      TIERS.every(
        (tier) =>
          preset[tier].provider === tiers[tier].provider &&
          preset[tier].model === tiers[tier].model,
      )
    ) {
      return name;
    }
  }
  return null;
}
