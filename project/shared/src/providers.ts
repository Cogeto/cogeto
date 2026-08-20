/**
 * Model provider configuration (V2.4 item 7.1): the admin surfaces over
 * providers and tier assignments, and the one choice a user makes for
 * themselves.
 *
 * **No API key appears in any type in this file.** A saved key is never
 * returned to the client under any circumstance; `hasApiKey` is the whole of
 * what a client learns about it.
 */

/**
 * The provider families an admin can create. `self_hosted` is any
 * OpenAI-compatible endpoint: llama.cpp, Ollama, vLLM, LM Studio, or a proxy in
 * front of several of them.
 */
export const PROVIDER_TYPES = ['mistral', 'openai', 'anthropic', 'self_hosted'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/**
 * The legacy value the seed writes for an instance already bound to the local
 * Ollama runtime. It is not offered when creating a provider: the runtime is
 * reachable as an ordinary self-hosted endpoint, and this value exists only so
 * an instance that was on it keeps its exact adapter behaviour, its per-tier
 * timeouts and its configuration id.
 */
export const LEGACY_PROVIDER_TYPE = 'ollama';

/** Every type a stored provider row may carry. */
export type StoredProviderType = ProviderType | typeof LEGACY_PROVIDER_TYPE;

/** The four tiers an assignment names. */
export const MODEL_TIERS = ['pipeline', 'answer', 'embeddings', 'vision'] as const;
export type ModelTierName = (typeof MODEL_TIERS)[number];

/** How a provider answered its last probe. */
export type ProviderHealthState = 'ok' | 'unreachable' | 'auth_failed' | 'unknown';

export interface ProviderHealthDto {
  state: ProviderHealthState;
  /** One operator-actionable sentence. Never a credential, never a token. */
  detail: string | null;
  checkedAt: string | null;
}

export interface ProviderDto {
  id: string;
  label: string;
  type: StoredProviderType;
  /** The endpoint, for the types that have one; null for a hosted vendor API
   * and for the managed provider, whose endpoint is the hosting plan's own
   * detail and is never shown or edited. */
  baseUrl: string | null;
  /**
   * True for the single provider reconciled from provision-time configuration
   * on a hosted plan. The card is read-only: no key field, no endpoint edit,
   * no delete; everything else on the instance stays the admin's.
   */
  managed: boolean;
  /** Whether a key is stored. The key itself is never returned. */
  hasApiKey: boolean;
  /** True when this type needs a key at all (a self-hosted server often has none). */
  requiresApiKey: boolean;
  /** True when this type can serve the embeddings tier. */
  supportsEmbeddings: boolean;
  /**
   * True when this type's adapter can read an image, so it may serve the
   * vision tier (issue #571). A vendor whose models are multimodal but whose
   * adapter here has no image path is false: the interface must offer what
   * this instance can do, not what the vendor could.
   */
  supportsVision: boolean;
  health: ProviderHealthDto;
  /** Tiers currently assigned to this provider — why it cannot be deleted. */
  assignedTiers: ModelTierName[];
  createdAt: string;
}

export interface ProviderAssignmentDto {
  tier: ModelTierName;
  providerId: string | null;
  providerLabel: string | null;
  providerType: StoredProviderType | null;
  model: string | null;
  updatedAt: string | null;
}

/** What the published trust scores say about the configuration in force. */
export interface TrustScoreSummaryDto {
  /** The configuration id these numbers were measured under. */
  configurationId: string;
  /** Null when nothing published matches: the honest "not evaluated". */
  evaluated: boolean;
  release: string | null;
  extractionPrecision: number | null;
  extractionRecall: number | null;
  verificationAgreement: number | null;
}

export interface ConfigurationChangeDto {
  id: string;
  configurationId: string;
  previousConfigurationId: string | null;
  tier: ModelTierName;
  providerLabel: string;
  model: string;
  changedAt: string;
}

/**
 * GET /api/admin/model-configuration — everything the assignment page renders.
 */
export interface ModelConfigurationDto {
  /** The stable configuration id, the trust artifacts' join key. */
  configurationId: string;
  configured: boolean;
  assignments: ProviderAssignmentDto[];
  trust: TrustScoreSummaryDto;
  /** Newest first, capped. */
  history: ConfigurationChangeDto[];
  /**
   * Non-null only where the managed rebuild is unavailable (a root that wired
   * no memory module); the interface then names the operator command. On a
   * full instance this is null and the embeddings tier changes through the
   * plan/confirm rebuild flow below.
   */
  embeddingsLocked: {
    /** The operator command that is the interim path. */
    operatorCommand: string;
  } | null;
  /** The managed rebuild in flight, when there is one. */
  embeddingRebuild: EmbeddingRebuildStatusDto | null;
  /** The answer models an admin has enabled for users to choose between. */
  answerOptions: AnswerModelOptionDto[];
}

/**
 * The managed embedding rebuild (V2.4 item 7.1 second half): live progress
 * for the Models page, the capabilities panel and the health report.
 */
export interface EmbeddingRebuildStatusDto {
  status: 'running' | 'failed';
  /** 'embedding' while the corpus is being re-embedded; 'finalizing' once the
   * count is full and the atomic switch is being prepared. */
  phase: 'embedding' | 'finalizing';
  targetProviderLabel: string | null;
  targetModel: string;
  factsDone: number;
  factsTotal: number;
  /** Accumulated under the same chars/4 accounting the budget meter charges. */
  tokensSpent: number;
  startedAt: string | null;
  /** Rate-based; null until enough progress exists to compute one. */
  estimatedSecondsRemaining: number | null;
  /** The failure, or the reason the rebuild is paused (budget exhausted). */
  error: string | null;
  cancelRequested: boolean;
}

/**
 * POST /api/admin/model-configuration/embeddings/rebuild-plan — what changing
 * the embeddings model to this binding will cost and do, BEFORE anything is
 * saved. The token estimate uses the same accounting the meter charges; the
 * duration extrapolates the plan probe's measured latency over the corpus's
 * batches, stated as an estimate.
 */
export interface EmbeddingRebuildPlanDto {
  providerId: string;
  providerLabel: string;
  model: string;
  /** Memories that carry a vector and will be re-embedded. */
  facts: number;
  estimatedTokens: number;
  estimatedSeconds: number;
  /** PROBED from a real embedding, never a registry guess. */
  dimensions: number;
  /** The configuration id the completed switch would produce. */
  resultingConfigurationId: string;
  /** Whether published trust scores exist for that configuration. */
  evaluated: boolean;
}

/** POST body for rebuild-plan and rebuild: the target embeddings binding. */
export interface EmbeddingRebuildRequest {
  providerId: string;
  model: string;
}

export interface AnswerModelOptionDto {
  id: string;
  label: string;
  providerId: string;
  providerLabel: string;
  providerType: StoredProviderType;
  model: string;
}

/** POST /api/admin/providers — creating one. The key is write-only. */
export interface CreateProviderRequest {
  label: string;
  type: ProviderType;
  baseUrl?: string;
  /** Sent once, encrypted at rest, never returned. Omit to store none. */
  apiKey?: string;
}

/** PATCH /api/admin/providers/:id — omitting `apiKey` leaves the stored one. */
export interface UpdateProviderRequest {
  label?: string;
  baseUrl?: string;
  /** A new key. `null` clears the stored one; omitted leaves it untouched. */
  apiKey?: string | null;
}

/** The result of a probe, in the words the interface shows. */
export interface ProviderProbeDto {
  ok: boolean;
  reason: string | null;
  detail: string | null;
}

/** GET /api/admin/providers/:id/models — discovery, which always OFFERS. */
export interface ProviderModelsDto {
  /** What the endpoint advertises. Empty is a valid answer, not a failure. */
  models: string[];
  /** Present when the models route could not be read; manual entry still works. */
  error: string | null;
  /**
   * True when this endpoint is known to serve models it does not advertise: a
   * proxy in front of several runtimes is the ordinary case, and the interface
   * must not imply the list is exhaustive.
   */
  mayBePartial: boolean;
}

/** PUT /api/admin/model-configuration/:tier — an explicit, confirmed change. */
export interface AssignTierRequest {
  providerId: string | null;
  model: string | null;
}

/** GET/PUT /api/settings/answer-model — the one choice a user makes. */
export interface UserAnswerModelDto {
  /** The user's choice, or null for the instance's assigned answer model. */
  optionId: string | null;
  /** What answering uses right now, in words. */
  activeLabel: string;
  options: AnswerModelOptionDto[];
}
