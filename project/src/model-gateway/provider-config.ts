/**
 * Model provider configuration: the shared types, the preset table, the
 * configuration-id derivation, and the two environment readers that remain.
 *
 * On a running instance the DATABASE is the only source of model
 * configuration (the interface writes it, `resolveFromRecords` reads it).
 * The environment contributes exactly two things, and both are deployment
 * facts rather than model choices: the per-tier timeouts for self-hosted
 * endpoints and the reasoning headroom (`resolveRuntimeModelSettings`).
 *
 * The one environment resolver left, `resolveEvalProvidersFromEnv`, belongs
 * to the EVAL HARNESS and the dev smoke tools alone: they run in CI against
 * no instance database, and pinning the configuration a measurement ran
 * against is the point. No instance boot path may call it.
 */

export type ModelProviderId = 'mistral' | 'openai' | 'anthropic' | 'ollama';

export const MODEL_PROVIDER_IDS: readonly ModelProviderId[] = [
  'mistral',
  'openai',
  'anthropic',
  'ollama',
];

/** Providers with an embeddings API — Anthropic has none (ruling 3). */
export const EMBEDDING_CAPABLE: readonly ModelProviderId[] = ['mistral', 'openai', 'ollama'];

/**
 * Adapters that can read an image (issue #571). The twin of the line above,
 * and a fact about THIS CODE rather than about the vendors: an adapter belongs
 * here exactly when it implements `describeImage`. Anthropic's models are
 * multimodal and it is absent, because `AnthropicModelGateway` has no image
 * path. The database path gates the same question through
 * `ProviderTypeSpec.supportsVision`; both must agree, and a spec asserts it.
 */
export const VISION_CAPABLE: readonly ModelProviderId[] = ['mistral', 'openai', 'ollama'];

/**
 * The concrete endpoint and credential ONE tier talks to (V2.4 item 7.1).
 *
 * The environment shape had exactly one endpoint and one key per provider id,
 * which is why `endpoints` and `keys` below are keyed that way. That stopped
 * being enough the moment providers became records an admin creates: two
 * self-hosted endpoints, or a hosted OpenAI key beside a llama.cpp proxy, are
 * both provider id `openai` and must not share a base URL or a bearer token.
 *
 * Absent means "use the instance-wide endpoint and key for this provider id",
 * which is precisely the environment behaviour, so an environment-resolved
 * configuration is byte-identical to what it always was.
 */
export interface ProviderEndpoint {
  /** The provider record's id — the adapter cache key, so two records of the
   * same type get two adapters and never share a credential. */
  id: string;
  /** The admin's label, for error messages and the boot log. Never a key. */
  label: string;
  /** Adapter-ready base URL (the OpenAI-compatible surface, `/v1` included). */
  baseUrl: string;
  /** Decrypted at the moment of use. Never logged, never serialized. */
  apiKey: string;
  /** True when this endpoint is somebody's own server rather than the vendor's
   * hosted API: decides per-tier timeouts and per-request thinking control. */
  selfHosted: boolean;
}

export interface TierBinding {
  provider: ModelProviderId;
  model: string;
  /** V2.4 item 7.1: the provider record this binding resolves through. Absent
   * for an environment-resolved configuration. */
  endpoint?: ProviderEndpoint;
}

/**
 * One answer model a user may pick for themselves (V2.4 item 7.1). The admin
 * controls the set; a user's stored choice is the OPTION ID, never a model
 * string, so a call site still names a tier and the seam still owns the mapping
 * from configuration to concrete model.
 */
export interface AnswerModelOption {
  /** Opaque id — what a user's stored preference references. */
  id: string;
  /** The admin's display name for this option. */
  label: string;
  binding: TierBinding;
}

/**
 * Local Ollama runtime binding. `baseUrl` is the runtime ROOT
 * (never `/v1` — the adapter derives the OpenAI-compatible surface and the
 * probe endpoint from it). Per-tier timeouts default higher than hosted
 * providers: first-token latency on consumer hardware is seconds, not
 * milliseconds (ruling 2).
 */
export interface OllamaRuntimeConfig {
  baseUrl: string;
}

/**
 * Per-tier request timeouts for a SELF-HOSTED endpoint.
 *
 * These used to belong to the Ollama binding, which was true only while Ollama
 * was the only way to run a model yourself. An OpenAI-compatible server on your
 * own hardware (llama.cpp, vLLM, LM Studio) has exactly the same property:
 * first-token latency is seconds to minutes, not milliseconds, and a hosted
 * provider's implicit expectations do not apply.
 *
 * They are NOT applied to hosted providers. Absent is the historical behaviour
 * for every hosted configuration and stays byte-identical.
 */
export interface TierTimeoutsMs {
  pipeline: number;
  answer: number;
  embedding: number;
  /** Sized separately: reading a page image is the slowest call the instance
   * makes, and a timeout tuned for a sentence of text will cut it off. */
  vision: number;
}

export interface ResolvedModelProviders {
  /** False → the gateway boots unconfigured; model calls fail with a typed error. */
  configured: boolean;
  /** The configuration id — the trust page's join key; `unconfigured` when off. */
  id: string;
  /** The matched preset name, or null for a custom tier mix. */
  preset: string | null;
  tiers: { pipeline: TierBinding; answer: TierBinding; embedding: TierBinding };
  /**
   * The vision binding, or null when this instance has none (V2.1 item 4.1).
   * Deliberately OUTSIDE `tiers` and absent from every preset: vision is a
   * capability an operator opts into for their own runtime, never something a
   * default turns on. Null is a complete answer, not a missing value: it means
   * the reading ladder stops at OCR and says so.
   */
  vision: TierBinding | null;
  /** API keys per provider — never logged, stored, or serialized to any DTO. */
  keys: Partial<Record<ModelProviderId, string>>;
  endpoints: { openaiBaseUrl: string; anthropicBaseUrl: string };
  /** Present only when a tier is bound to the local runtime. */
  ollama: OllamaRuntimeConfig | null;
  /**
   * Per-tier timeouts, applied to SELF-HOSTED endpoints only: the local Ollama
   * runtime, and an OpenAI-compatible base URL that is not the hosted default.
   */
  timeoutsMs: TierTimeoutsMs;
  /**
   * The maxTokens multiplier applied to a binding the reasoning probe marked
   * as reasoning (Part B of reasoning support): a cap sized for an answer is
   * not sized for an answer plus its deliberation. Applied ONLY after a
   * response actually carried a reasoning field — configuration alone never
   * changes a request, so a non-reasoning instance is byte-identical.
   */
  reasoningHeadroom: number;
  /** True when `endpoints.openaiBaseUrl` points at something self-hosted. */
  openaiSelfHosted: boolean;
  redacted: boolean;
  /**
   * Where this configuration came from. `database` is the only source on a
   * running instance; `environment` is the eval harness's and the dev smoke
   * tools'; `none` is the boot placeholder before the database has been read.
   */
  source: 'environment' | 'database' | 'none';
  /**
   * Bumped every time the live configuration is replaced (V2.4 item 7.1). The
   * gateway caches its adapters against this number, so a saved assignment
   * takes effect on the next call without a restart, and an unchanged
   * configuration rebuilds nothing.
   */
  version: number;
  /**
   * The answer models an admin has enabled for users to pick between. Empty
   * means the answer tier is not user-switchable on this instance, which is
   * exactly the behaviour every instance had before V2.4 item 7.1.
   */
  answerOptions: readonly AnswerModelOption[];
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
  // All three tiers on the local Ollama runtime
  // generation on the pulled Gemma variant, embeddings on bge-m3 (multilingual,
  // 1024 dimensions). Requires COGETO_OLLAMA_BASE_URL; needs no API key.
  'ollama-local': {
    pipeline: { provider: 'ollama', model: 'gemma3:12b' },
    answer: { provider: 'ollama', model: 'gemma3:12b' },
    embedding: { provider: 'ollama', model: 'bge-m3' },
  },
};

/**
 * Ruling 2 defaults for a SELF-HOSTED endpoint: generation tiers 5 min,
 * embeddings 2 min. Named for what they are rather than for Ollama, which is
 * one such endpoint among several (issue #567).
 */
export const SELF_HOSTED_TIMEOUT_DEFAULTS_MS = {
  pipeline: 300_000,
  answer: 300_000,
  embedding: 120_000,
  // A page image through a local multimodal model on consumer hardware is
  // minutes, not seconds; the pipeline that calls it is a background job.
  vision: 600_000,
} as const;

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
  ollama: 'COGETO_OLLAMA_API_KEY',
};

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Deterministic configuration id (ruling 3): preset name on an exact match,
 * else the full per-tier derivation; `-redacted` suffix as before. */
export function deriveProvidersId(
  tiers: PresetTiers,
  redacted: boolean,
  vision: TierBinding | null = null,
): string {
  // Vision joins the id because it changes what a run MEASURED: the same corpus
  // read with and without vision is two different measurements, and the trust
  // page joins on this key.
  const visionPart = vision ? `--vis-${vision.provider}-${slug(vision.model)}` : '';
  const suffix = `${visionPart}${redacted ? '-redacted' : ''}`;
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
    `${name}="${value}" is not a known provider, use one of: ${MODEL_PROVIDER_IDS.join(' | ')}`,
  );
}

/**
 * The environment configuration a running instance still reads: the per-tier
 * self-hosted timeouts and the reasoning headroom. Deployment facts, not model
 * choices — which model runs is the database's answer alone.
 */
export function resolveRuntimeModelSettings(env: NodeJS.ProcessEnv): {
  timeoutsMs: TierTimeoutsMs;
  reasoningHeadroom: number;
} {
  const timeoutsMs: TierTimeoutsMs = {
    pipeline: readTimeoutMs(env, 'COGETO_MODEL_TIMEOUT_PIPELINE_MS', 'pipeline'),
    answer: readTimeoutMs(env, 'COGETO_MODEL_TIMEOUT_ANSWER_MS', 'answer'),
    embedding: readTimeoutMs(env, 'COGETO_MODEL_TIMEOUT_EMBEDDINGS_MS', 'embedding'),
    vision: readTimeoutMs(env, 'COGETO_MODEL_TIMEOUT_VISION_MS', 'vision'),
  };
  // Reasoning headroom (Part B). Deliberately NOT part of the configuration id:
  // the id fingerprints what a measurement ran against, and whether a binding
  // reasons is a PROBED runtime fact, not configuration — the id is derived
  // before any probe can run. The fingerprint marker is appended at trust
  // EMISSION time from the probe (Part C, configurationForEmission), never here.
  const headroomRaw = read(env, 'COGETO_REASONING_HEADROOM');
  let reasoningHeadroom = 4;
  if (headroomRaw !== undefined) {
    const value = Number(headroomRaw);
    if (!Number.isInteger(value) || value < 1) {
      throw new ModelProviderConfigError(
        `COGETO_REASONING_HEADROOM="${headroomRaw}" is not a positive integer multiplier`,
      );
    }
    reasoningHeadroom = value;
  }
  return { timeoutsMs, reasoningHeadroom };
}

/**
 * The boot placeholder: what `loadConfig` hands every process BEFORE the
 * database has been read. Nothing is resolved from the environment — a stale
 * model variable in `.env` cannot reach this shape by construction.
 * `installModelConfiguration` replaces it with the database's resolution
 * before anything model-facing is built; a bare entrypoint that never opens
 * the instance database (migrate, preflight) simply keeps it, which is
 * honest: those processes make no model calls.
 */
export function unconfiguredModelProviders(input: {
  redacted: boolean;
  timeoutsMs: TierTimeoutsMs;
  reasoningHeadroom: number;
}): ResolvedModelProviders {
  const unassigned: TierBinding = { provider: 'mistral', model: 'unassigned' };
  return {
    configured: false,
    id: 'unconfigured',
    preset: null,
    tiers: { pipeline: { ...unassigned }, answer: { ...unassigned }, embedding: { ...unassigned } },
    vision: null,
    keys: {},
    endpoints: { openaiBaseUrl: '', anthropicBaseUrl: '' },
    ollama: null,
    timeoutsMs: input.timeoutsMs,
    reasoningHeadroom: input.reasoningHeadroom,
    openaiSelfHosted: false,
    redacted: input.redacted,
    source: 'none',
    version: 0,
    answerOptions: [],
  };
}

/**
 * Resolve a model provider configuration from the environment — FOR THE EVAL
 * HARNESS and the dev smoke tools only. They run against no instance
 * database, and pinning the configuration a measurement ran against is the
 * point (docs/eval-golden-set.md). No instance boot path may call this: on a
 * running instance the database is the only source of model configuration,
 * and `model-config-env.spec.ts` asserts the confinement structurally.
 * Precedence per tier: explicit COGETO_PROVIDER_x + COGETO_MODEL_x vars >
 * COGETO_PROVIDER_PRESET expansion > legacy COGETO_MISTRAL_MODEL_x vars >
 * the mistral-default preset. Throws ModelProviderConfigError with the exact
 * variable to fix on any invalid combination.
 */
export function resolveEvalProvidersFromEnv(
  env: NodeJS.ProcessEnv,
  options: { redacted: boolean },
): ResolvedModelProviders {
  const presetName = read(env, 'COGETO_PROVIDER_PRESET');
  if (presetName && !PROVIDER_PRESETS[presetName]) {
    throw new ModelProviderConfigError(
      `COGETO_PROVIDER_PRESET="${presetName}" is not a known preset, use one of: ${Object.keys(
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
    pipeline: read(env, 'COGETO_MISTRAL_MODEL_PIPELINE'),
    answer: read(env, 'COGETO_MISTRAL_MODEL_ANSWER'),
    embedding: read(env, 'COGETO_MISTRAL_EMBED_MODEL'),
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
            `no model configured for the ${tier} tier on provider "${provider}": set COGETO_MODEL_${TIER_SUFFIX[tier]}`,
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
      `provider "${tiers.embedding.provider}" has no embeddings API: the embeddings tier must use ` +
        `one of: ${EMBEDDING_CAPABLE.join(' | ')} (set COGETO_PROVIDER_EMBEDDINGS)`,
    );
  }

  // The vision binding (V2.1 item 4.1): entirely opt-in, no preset, no default
  // model. A provider alone is not enough — an image model must be NAMED,
  // because no provider has one obvious choice and guessing would produce a
  // capability that claims to exist and fails on the first page.
  const visionProviderVar = read(env, 'COGETO_PROVIDER_VISION');
  const visionModelVar = read(env, 'COGETO_MODEL_VISION');
  let vision: TierBinding | null = null;
  if (visionProviderVar || visionModelVar) {
    if (!visionProviderVar || !visionModelVar) {
      throw new ModelProviderConfigError(
        'the vision tier needs BOTH COGETO_PROVIDER_VISION and COGETO_MODEL_VISION: ' +
          'no provider has a default image model, and a guessed one would fail on the first page',
      );
    }
    const visionProvider = parseProvider('COGETO_PROVIDER_VISION', visionProviderVar);
    // Fail at resolution, never at the first page: an unreadable image three
    // hours into an ingestion run is the same defect this catches here.
    if (!VISION_CAPABLE.includes(visionProvider)) {
      throw new ModelProviderConfigError(
        `provider "${visionProvider}" cannot read images: the vision tier must use one of: ` +
          `${VISION_CAPABLE.join(' | ')} (set COGETO_PROVIDER_VISION)`,
      );
    }
    vision = { provider: visionProvider, model: visionModelVar };
  }

  // Is the OpenAI-compatible endpoint somebody's own server rather than
  // OpenAI's? That single question decides two things below: whether per-tier
  // timeouts apply (a self-hosted model answers in seconds to minutes), and
  // whether an API key is required (your own server may well have no auth).
  const openaiBaseUrl = read(env, 'COGETO_OPENAI_BASE_URL') ?? DEFAULT_OPENAI_BASE_URL;
  const openaiSelfHosted = openaiBaseUrl !== DEFAULT_OPENAI_BASE_URL;

  const { timeoutsMs, reasoningHeadroom } = resolveRuntimeModelSettings(env);

  const keys: Partial<Record<ModelProviderId, string>> = {};
  const mistralKey = read(env, 'COGETO_MISTRAL_API_KEY');
  if (mistralKey) keys.mistral = mistralKey;
  const openaiKey = read(env, 'COGETO_OPENAI_API_KEY');
  if (openaiKey) keys.openai = openaiKey;
  const anthropicKey = read(env, 'COGETO_ANTHROPIC_API_KEY');
  if (anthropicKey) keys.anthropic = anthropicKey;
  // The local runtime requires no real key: a dummy
  // bearer is synthesized unless the operator fronts the runtime with an
  // authenticating proxy — so the missing-key refusal below never fires for
  // ollama while staying exactly as strict for every hosted provider.
  keys.ollama = read(env, 'COGETO_OLLAMA_API_KEY') ?? 'ollama';
  // A self-hosted OpenAI-compatible server (llama.cpp, vLLM, LM Studio) often
  // runs with no auth at all, and demanding a meaningless placeholder in .env
  // is friction with no safety in it. The requirement STAYS for the hosted API,
  // where a missing key is a real misconfiguration and refusing at boot beats a
  // 401 on the first request.
  if (openaiSelfHosted && !keys.openai) keys.openai = 'self-hosted';

  const referenced = [
    ...new Set([
      ...TIERS.map((tier) => tiers[tier].provider),
      ...(vision ? [vision.provider] : []),
    ]),
  ];
  const missingKeys = referenced.filter((provider) => !keys[provider]);

  // Local runtime binding: the base URL has NO
  // default — localhost, LAN, and WireGuard addresses are all deployment
  // choices — so a tier bound to ollama without it refuses boot naming the
  // variable. A pasted `/v1` suffix is tolerated and stripped: the config
  // names the runtime root; the adapter derives the API surfaces.
  let ollama: OllamaRuntimeConfig | null = null;
  if (referenced.includes('ollama')) {
    const rawBaseUrl = read(env, 'COGETO_OLLAMA_BASE_URL');
    if (!rawBaseUrl) {
      throw new ModelProviderConfigError(
        `provider "ollama" is selected for ${[
          ...TIERS.filter((tier) => tiers[tier].provider === 'ollama'),
          ...(vision?.provider === 'ollama' ? ['vision'] : []),
        ].join(', ')} but COGETO_OLLAMA_BASE_URL is not set, set it to the Ollama runtime root ` +
          `(e.g. http://10.0.0.1:11434)`,
      );
    }
    ollama = { baseUrl: rawBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') };
  }

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
            `provider "${provider}" is selected for ${[
              ...TIERS.filter((tier) => tiers[tier].provider === provider),
              ...(vision?.provider === provider ? ['vision'] : []),
            ].join(', ')} but ${KEY_VAR[provider]} is not set`,
        )
        .join('; ');
      throw new ModelProviderConfigError(details);
    }
  }

  return {
    configured,
    id: configured ? deriveProvidersId(tiers, options.redacted, vision) : 'unconfigured',
    preset: presetForTiers(tiers),
    tiers,
    vision,
    keys,
    endpoints: {
      openaiBaseUrl,
      anthropicBaseUrl: read(env, 'COGETO_ANTHROPIC_BASE_URL') ?? DEFAULT_ANTHROPIC_BASE_URL,
    },
    ollama,
    timeoutsMs,
    reasoningHeadroom,
    openaiSelfHosted,
    redacted: options.redacted,
    source: 'environment',
    version: 0,
    answerOptions: [],
  };
}

/**
 * A tier's timeout, from its provider-neutral variable or the default.
 *
 * ONE NAME PER SETTING (issue #567). The `COGETO_OLLAMA_TIMEOUT_*` alias was
 * honoured here alongside `COGETO_MODEL_TIMEOUT_*` for the same four values,
 * and that duplication is exactly how the deploy channel drifted: the deploy
 * compose wired the alias while omitting the documented name, so an operator
 * raising the documented timeout changed nothing. The alias is removed rather
 * than kept, because it names a runtime the setting stopped being about and
 * because no instance carries it (the timeout applies to any self-hosted
 * endpoint, never only to Ollama).
 */
function readTimeoutMs(
  env: NodeJS.ProcessEnv,
  name: string,
  tier: keyof typeof SELF_HOSTED_TIMEOUT_DEFAULTS_MS,
): number {
  const raw = read(env, name);
  if (raw === undefined) return SELF_HOSTED_TIMEOUT_DEFAULTS_MS[tier];
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ModelProviderConfigError(
      `${name}="${raw}" is not a positive integer number of milliseconds`,
    );
  }
  return value;
}

export function presetForTiers(tiers: PresetTiers): string | null {
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
