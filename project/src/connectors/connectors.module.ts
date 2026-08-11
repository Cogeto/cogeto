import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import { SourceRevisionStore } from '../ingestion/index';
import { ConnectorRegistry } from './connector-registry';
import type { ConnectorDescriptor } from './connector-descriptor';
import { ConnectorStore } from './persistence/connector-store';
import { ConnectorItemLedger } from './persistence/item-ledger';
import { ConnectorsController } from './connectors.controller';
import { ConnectorWebhookController } from './webhook.controller';
import { ConnectorSyncEngine } from './sync-engine';
import { ConnectorWebhookProcessor } from './webhook-processor';
import { ConnectorMaintenance } from './maintenance';
import { ConnectorPresenceSweep } from './presence-sweep';
import { ConnectorHealthSource } from './connector-health';
import { ConnectorItemCascade } from './connector-item-cascade';
import { CONNECTORS_OPTIONS } from './connectors.options';
import type { ConnectorsOptions } from './connectors.options';

/**
 * connectors — the connector platform (V2.5 item 8.1): what every external
 * connector inherits. Owns `connector`, `connector_sub_scope`,
 * `connector_item`, `connector_sync_run`, `connector_webhook_delivery` and
 * `connector_rate_limit`; the credential table is identity's, deliberately.
 * No external service lives here: descriptors are registered by the
 * composition roots (`register({ connectors })`), and the first real one
 * arrives as its own module in item 8.2. Decision record:
 * docs/features/connectors.md.
 */
@Module({})
export class ConnectorsModule {
  /** The app-side slice: the owner API and the webhook ingress. */
  static register(options: {
    options: ConnectorsOptions;
    connectors?: ConnectorDescriptor[];
    imports?: ModuleMetadata['imports'];
  }): DynamicModule {
    return {
      module: ConnectorsModule,
      imports: [...(options.imports ?? [])],
      controllers: [ConnectorsController, ConnectorWebhookController],
      providers: [
        { provide: CONNECTORS_OPTIONS, useValue: options.options },
        {
          provide: ConnectorRegistry,
          useValue: new ConnectorRegistry(options.connectors ?? []),
        },
        ConnectorStore,
        ConnectorItemLedger,
        ConnectorHealthSource,
      ],
      exports: [ConnectorHealthSource, ConnectorStore, ConnectorItemLedger],
    };
  }

  /** The worker-side slice: the sync engine and its jobs. */
  static forWorker(options: {
    options: ConnectorsOptions;
    connectors?: ConnectorDescriptor[];
    imports?: ModuleMetadata['imports'];
  }): DynamicModule {
    return {
      module: ConnectorsModule,
      imports: [...(options.imports ?? [])],
      providers: [
        { provide: CONNECTORS_OPTIONS, useValue: options.options },
        {
          provide: ConnectorRegistry,
          useValue: new ConnectorRegistry(options.connectors ?? []),
        },
        ConnectorStore,
        ConnectorItemLedger,
        ConnectorSyncEngine,
        ConnectorWebhookProcessor,
        ConnectorMaintenance,
        ConnectorPresenceSweep,
        ConnectorHealthSource,
        SourceRevisionStore,
      ],
      exports: [
        ConnectorSyncEngine,
        ConnectorWebhookProcessor,
        ConnectorMaintenance,
        ConnectorPresenceSweep,
        ConnectorHealthSource,
        ConnectorStore,
      ],
    };
  }
}

/** The cascade adapter's own slim module (the cascade-family precedent):
 * table access only, importable by memory's cascade bindings without pulling
 * the whole platform. */
@Module({
  providers: [ConnectorItemLedger, ConnectorItemCascade],
  exports: [ConnectorItemCascade],
})
export class ConnectorItemCascadeModule {}
