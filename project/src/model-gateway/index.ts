/** Public interface of the model-gateway seam (spec §15 rule 1). */
export { ModelGatewayModule } from './model-gateway.module';
export { ModelGateway } from './model-gateway.service';
export { MistralModelGateway } from './mistral.gateway';
// Provider adapters — exported for tests; production always
// composes them through createModelGateway + the configuration resolver.
// Model configuration surface. The DATABASE is the only source on a running
// instance; `resolveEvalProvidersFromEnv` belongs to the eval harness and the
// dev smoke tools alone, and `resolveRuntimeModelSettings` reads the two
// deployment knobs (self-hosted timeouts, reasoning headroom) that remain
// environment configuration.
export {
  resolveEvalProvidersFromEnv,
  resolveRuntimeModelSettings,
  unconfiguredModelProviders,
  PROVIDER_PRESETS,
  MODEL_PROVIDER_IDS,
  EMBEDDING_CAPABLE,
  deriveProvidersId,
  presetForTiers,
  OLLAMA_TIMEOUT_DEFAULTS_MS,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_ANTHROPIC_BASE_URL,
  ModelProviderConfigError,
} from './provider-config';
export type {
  ResolvedModelProviders,
  ModelProviderId,
  TierBinding,
  ProviderEndpoint,
  AnswerModelOption,
} from './provider-config';
// The live configuration (V2.4 item 7.1): one mutable object per process, so a
// saved assignment reaches every consumer without a restart and the gateway
// rebuilds its adapters exactly once.
export { LiveModelConfiguration } from './live-configuration';
// Provider discovery and validation (V2.4 item 7.1). Everything that opens a
// socket to a provider lives in the seam; the module that manages provider
// RECORDS asks these two functions and never speaks HTTP itself.
export {
  embeddingRunConfiguration,
  listProviderModels,
  probeProviderModel,
  DEFAULT_PROVIDER_PROBE_TIMEOUT_MS,
  DEFAULT_MODEL_LIST_TIMEOUT_MS,
} from './provider-probe';
export type {
  ProbeTarget,
  ProbeTier,
  ProviderProbeFailure,
  ProviderProbeResult,
} from './provider-probe';
// Local-runtime boot probe: fail loudly at startup,
// never at first request. Called by the app, worker, and reindex entrypoints.
export { assertLocalRuntimeReady, probeLocalRuntime } from './local-runtime';
// The vision probe (V2.1 item 4.1): the only honest answer to "can this
// configuration read images" is to send one, so this is what the capability
// registry and the boot banner call.
export {
  probeVision,
  probeImagePng,
  PROBE_IMAGE_MEDIA_TYPE,
  DEFAULT_VISION_PROBE_TIMEOUT_MS,
} from './vision-probe';
export type { VisionProbeResult } from './vision-probe';
// The reasoning probe (Part B of reasoning support): whether a configuration
// returns a separate reasoning field can only be answered by sending a prompt,
// for the same reason vision can only be answered by sending an image. Called
// by the capability registry (BEFORE the vision probe, because its side effect
// arms the maxTokens headroom the vision probe needs) and by the worker at boot.
export {
  probeReasoning,
  DEFAULT_REASONING_PROBE_TIMEOUT_MS,
  REASONING_PROBE_MAX_TOKENS,
} from './reasoning-probe';
export type { ReasoningProbeResult } from './reasoning-probe';
export { VisionUnavailableError, ReasoningExhaustedBudgetError } from './errors';
export type { VisionUnavailableReason } from './errors';
export type {
  CompletionRequest,
  CompletionResult,
  StreamDelta,
  StructuredExtractionRequest,
  VisionImage,
  VisionRequest,
} from './model-gateway.service';
export { ModelGatewayError, ModelBudgetExceededError } from './errors';
export { loadPrompt, recordPromptVersion } from './prompt-loader';
// The untrusted-data fence (audit 2.0 SEC-4). Prompt composition happens in the
// domain modules, but the rule about what a model may treat as an instruction
// belongs with the seam every model call passes through.
export { fenceUntrusted, untrustedBoundary } from './untrusted-fence';
export type { PromptArtifact } from './prompt-loader';
// Gateway construction goes through this factory everywhere so the redaction
// decorator (spec §12.2) wraps ALL model traffic — no path bypasses it.
export { createModelGateway } from './factory';
// The decorator + its port are exported for tests; the RedactionClient (the only
// thing that reaches the sidecar over HTTP) is deliberately NOT exported, so no
// module outside the gateway can call the sidecar (architectural constraint).
// The budget decorator — exported for tests; wired via the factory.
