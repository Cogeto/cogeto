import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { ModelGateway } from './model-gateway.service';
import { createModelGateway } from './factory';
import type { RedactionConfig } from './factory';
import type { ResolvedModelProviders } from './provider-config';
import { MODEL_USAGE_METER } from '../infrastructure/index';
import type { ModelUsageMeter } from '../infrastructure/index';

export interface ModelGatewayModuleOptions {
  /** The resolved per-tier provider configuration (decision 0040). Absent or
   * unconfigured → the process boots normally; model calls fail with a typed error. */
  providers?: ResolvedModelProviders;
  /** Redaction mode (Addendum B.8) — wraps the gateway when enabled. */
  redaction?: RedactionConfig;
  /**
   * Per-user daily model budget (FIX-2 QS-2). When true, the gateway is wrapped
   * with the {@link MODEL_USAGE_METER} provided by the global LimitsModule; the
   * worker opens no usage scope, so its pipeline traffic stays unmetered.
   */
  budget?: boolean;
}

/**
 * model-gateway — leaf seam for ALL model and embedding calls (§A.10). Routes
 * per-tier to the configured provider adapters (decision 0040); no other
 * module may import a provider client or reach a provider endpoint
 * (dependency-cruiser rules + the `no_provider_leakage` test).
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
          useFactory: (usageMeter?: ModelUsageMeter) =>
            createModelGateway({
              providers: options.providers,
              redaction: options.redaction,
              usageMeter: options.budget ? usageMeter : undefined,
            }),
          // The meter comes from the global LimitsModule; optional so a root
          // that registers no LimitsModule (or budget: false) still boots.
          inject: [{ token: MODEL_USAGE_METER, optional: true }],
        },
      ],
      exports: [ModelGateway],
    };
  }
}
