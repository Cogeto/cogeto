import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { ModelGateway } from './model-gateway.service';
import { createModelGateway } from './factory';
import type { RedactionConfig } from './factory';

export interface ModelGatewayModuleOptions {
  /** When absent the process boots normally; model calls fail with a typed error. */
  mistralApiKey?: string;
  /** `pipeline` tier model (extraction, verification) — decision 0007 ruling 3. */
  pipelineModel?: string;
  /** `answer` tier model (chat synthesis, eval grader). */
  answerModel?: string;
  embedModel?: string;
  /** Redaction mode (Addendum B.8) — wraps the gateway when enabled. */
  redaction?: RedactionConfig;
}

/**
 * model-gateway — leaf seam for ALL model and embedding calls (§A.10).
 * v1 routes everything to the Mistral API; no other module may import the
 * Mistral client (dependency-cruiser rule).
 */
@Module({})
export class ModelGatewayModule {
  static register(options: ModelGatewayModuleOptions = {}): DynamicModule {
    return {
      module: ModelGatewayModule,
      // Global like DatabaseModule: consumers (ingestion, tasks) inject
      // ModelGateway without re-registering the seam's options.
      global: true,
      providers: [
        {
          provide: ModelGateway,
          useFactory: () => createModelGateway(options),
        },
      ],
      exports: [ModelGateway],
    };
  }
}
