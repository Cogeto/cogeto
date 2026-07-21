/** Public interface of the model-gateway seam (§A.1 rule 1). */
export { ModelGatewayModule } from './model-gateway.module';
export type { ModelGatewayModuleOptions } from './model-gateway.module';
export { ModelGateway } from './model-gateway.service';
export { MistralModelGateway, UnconfiguredModelGateway } from './mistral.gateway';
export type { MistralGatewayOptions } from './mistral.gateway';
// Provider adapters (decision 0040) — exported for tests; production always
// composes them through createModelGateway + the configuration resolver.
export { OpenAiCompatibleModelGateway } from './openai.gateway';
export type { OpenAiCompatibleGatewayOptions } from './openai.gateway';
export { AnthropicModelGateway } from './anthropic.gateway';
export type { AnthropicGatewayOptions } from './anthropic.gateway';
export { TierRoutedModelGateway } from './routed.gateway';
// Per-instance provider configuration (decision 0040 ruling 3): ONE resolver
// for app, worker, bare entrypoints and the eval harness.
export {
  resolveModelProviders,
  deriveProvidersId,
  ModelProviderConfigError,
  PROVIDER_PRESETS,
  EMBEDDING_CAPABLE,
  MODEL_PROVIDER_IDS,
} from './provider-config';
export type { ResolvedModelProviders, TierBinding, ModelProviderId } from './provider-config';
export type {
  CompletionRequest,
  CompletionResult,
  TokenUsage,
  StructuredExtractionRequest,
} from './model-gateway.service';
export {
  ModelGatewayError,
  ModelGatewayNotConfiguredError,
  ModelBudgetExceededError,
} from './errors';
export { loadPrompt, recordPromptVersion } from './prompt-loader';
export type { PromptArtifact } from './prompt-loader';
// Gateway construction goes through this factory everywhere so the redaction
// decorator (Addendum B.8) wraps ALL model traffic — no path bypasses it.
export { createModelGateway } from './factory';
export type { CreateModelGatewayOptions, RedactionConfig } from './factory';
// The decorator + its port are exported for tests; the RedactionClient (the only
// thing that reaches the sidecar over HTTP) is deliberately NOT exported, so no
// module outside the gateway can call the sidecar (architectural constraint).
export { RedactingModelGateway } from './redacting.gateway';
// The budget decorator (FIX-2 QS-2) — exported for tests; wired via the factory.
export { BudgetedModelGateway } from './budgeted.gateway';
export type { RedactionPort, RedactionResult } from './redaction-client';
export { reidentifyText, reidentifyDeep } from './redaction-utils';
