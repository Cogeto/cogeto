import { ModelGateway } from './model-gateway.service';
import { MistralModelGateway, UnconfiguredModelGateway } from './mistral.gateway';
import { RedactingModelGateway } from './redacting.gateway';
import { RedactionClient } from './redaction-client';
import { BudgetedModelGateway } from './budgeted.gateway';
import type { ModelUsageMeter } from '../infrastructure/index';

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
  /**
   * Per-user daily model budget (FIX-2 QS-2). When present, the gateway is
   * wrapped so user-attributed calls are capped and metered; absent (eval,
   * smokes) leaves all calls unmetered.
   */
  usageMeter?: ModelUsageMeter;
}

/**
 * The single construction point for the model gateway (§A.10). Every process —
 * the DI module AND the bare entrypoints (eval, dream, reindex, …) — builds the
 * gateway here, so the redaction and budget decorators wrap ALL model traffic
 * uniformly and nothing can bypass them.
 *
 * Decorator order (outermost first): budget → redaction → provider. The budget
 * gate runs before any provider call and counts real model traffic; redaction
 * pseudonymizes inside it.
 */
export function createModelGateway(options: CreateModelGatewayOptions): ModelGateway {
  let gateway: ModelGateway = options.mistralApiKey
    ? new MistralModelGateway({
        apiKey: options.mistralApiKey,
        pipelineModel: options.pipelineModel,
        answerModel: options.answerModel,
        embedModel: options.embedModel,
      })
    : new UnconfiguredModelGateway();

  if (options.redaction?.enabled) {
    gateway = new RedactingModelGateway(
      gateway,
      new RedactionClient(options.redaction.url, options.redaction.timeoutMs),
    );
  }
  if (options.usageMeter) {
    gateway = new BudgetedModelGateway(gateway, options.usageMeter);
  }
  return gateway;
}
