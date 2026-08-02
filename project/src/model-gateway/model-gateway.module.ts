import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { ModelGateway } from './model-gateway.service';
import { createModelGateway } from './factory';
import type { RedactionConfig } from './factory';
import type { ResolvedModelProviders } from './provider-config';
import { ModelConfigController } from './model-config.controller';
import { MODEL_CONFIG_VIEW } from './model-config-view';
import type { ModelConfigView } from './model-config-view';
import { MODEL_USAGE_METER } from '../infrastructure/index';
import type { ModelUsageMeter } from '../infrastructure/index';

export interface ModelGatewayModuleOptions {
  /** The resolved per-tier provider configuration. Absent or
   * unconfigured → the process boots normally; model calls fail with a typed error. */
  providers?: ResolvedModelProviders;
  /** Redaction mode (spec §12.2) — wraps the gateway when enabled. */
  redaction?: RedactionConfig;
  /**
   * Per-user daily model budget. When true, the gateway is wrapped
   * with the {@link MODEL_USAGE_METER} provided by the global LimitsModule; the
   * worker opens no usage scope, so its pipeline traffic stays unmetered.
   */
  budget?: boolean;
  /**
   * Serve `GET /api/settings/model-config` from this root (V2.0 item 3.6 part
   * 2). The read-only Settings section displays the gateway's own resolved
   * configuration, so the route belongs to the seam that owns it — but only the
   * app serves HTTP, so the worker leaves this unset and never registers the
   * controller.
   */
  modelConfig?: ModelConfigView;
}

/**
 * model-gateway — leaf seam for ALL model and embedding calls (spec §12.1). Routes
 * per-tier to the configured provider adapters; no other
 * module may import a provider client or reach a provider endpoint
 * (dependency-cruiser rules + the `no_provider_leakage` test).
 */
@Module({})
export class ModelGatewayModule {
  static register(options: ModelGatewayModuleOptions = {}): DynamicModule {
    return {
      module: ModelGatewayModule,
      // Global like DatabaseModule: consumers (ingestion, retrieval) inject
      // ModelGateway without re-registering the seam's options.
      global: true,
      controllers: options.modelConfig ? [ModelConfigController] : [],
      providers: [
        ...(options.modelConfig
          ? [{ provide: MODEL_CONFIG_VIEW, useValue: options.modelConfig }]
          : []),
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
