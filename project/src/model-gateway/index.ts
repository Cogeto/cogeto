/** Public interface of the model-gateway seam (spec §15 rule 1). */
export { ModelGatewayModule } from './model-gateway.module';
export { ModelGateway } from './model-gateway.service';
export { MistralModelGateway } from './mistral.gateway';
// Provider adapters — exported for tests; production always
// composes them through createModelGateway + the configuration resolver.
// Per-instance provider configuration: ONE resolver
// for app, worker, bare entrypoints and the eval harness.
export { resolveModelProviders, PROVIDER_PRESETS } from './provider-config';
export type { ResolvedModelProviders } from './provider-config';
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
export { VisionUnavailableError } from './errors';
export type { VisionUnavailableReason } from './errors';
export type {
  CompletionRequest,
  CompletionResult,
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
