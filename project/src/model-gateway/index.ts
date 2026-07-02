/** Public interface of the model-gateway seam (§A.1 rule 1). */
export { ModelGatewayModule } from './model-gateway.module';
export type { ModelGatewayModuleOptions } from './model-gateway.module';
export { ModelGateway } from './model-gateway.service';
export { MistralModelGateway, UnconfiguredModelGateway } from './mistral.gateway';
export type { MistralGatewayOptions } from './mistral.gateway';
export type {
  CompletionRequest,
  CompletionResult,
  StructuredExtractionRequest,
} from './model-gateway.service';
export { ModelGatewayError, ModelGatewayNotConfiguredError } from './errors';
export { loadPrompt, recordPromptVersion } from './prompt-loader';
export type { PromptArtifact } from './prompt-loader';
