import { ModelGateway } from './model-gateway.service';
import { MistralModelGateway, UnconfiguredModelGateway } from './mistral.gateway';
import { RedactingModelGateway } from './redacting.gateway';
import { RedactionClient } from './redaction-client';

/**
 * Redaction wiring passed to the gateway factory (Addendum B.8). Enabled only on
 * the `redaction` profile; when off, the factory returns the underlying gateway
 * unchanged (byte-identical behavior — `redaction_off_noop`).
 */
export interface RedactionConfig {
  enabled: boolean;
  /** The sidecar base URL (compose sets it on the profile). */
  url: string;
  timeoutMs?: number;
}

export interface CreateModelGatewayOptions {
  /** When absent the process boots; model calls fail with a typed error. */
  mistralApiKey?: string;
  pipelineModel?: string;
  answerModel?: string;
  embedModel?: string;
  redaction?: RedactionConfig;
}

/**
 * The single construction point for the model gateway (§A.10). Every process —
 * the DI module AND the bare entrypoints (eval, dream, reindex, …) — builds the
 * gateway here, so the redaction decorator wraps ALL model traffic uniformly and
 * nothing can bypass it.
 */
export function createModelGateway(options: CreateModelGatewayOptions): ModelGateway {
  const inner: ModelGateway = options.mistralApiKey
    ? new MistralModelGateway({
        apiKey: options.mistralApiKey,
        pipelineModel: options.pipelineModel,
        answerModel: options.answerModel,
        embedModel: options.embedModel,
      })
    : new UnconfiguredModelGateway();

  if (!options.redaction?.enabled) return inner;
  return new RedactingModelGateway(
    inner,
    new RedactionClient(options.redaction.url, options.redaction.timeoutMs),
  );
}
