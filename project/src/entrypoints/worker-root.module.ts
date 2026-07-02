import { Module } from '@nestjs/common';
import { DatabaseModule } from '../infrastructure/index';
import { MemoryModule } from '../memory/index';
import { IngestionModule } from '../ingestion/index';
import { AgentsModule } from '../agents/index';
import { ConnectorsModule } from '../connectors/index';
import { TasksModule } from '../tasks/index';
import { ModelGatewayModule } from '../model-gateway/index';
import { COGETO_CONFIG } from './config';
import type { CogetoConfig } from './config';

/**
 * Composition root of the worker process — all slow-path jobs (§A.1): the
 * ingestion pipeline, reconciliation, deletion sagas, reminders, approved-action
 * execution. Graphile Worker wiring arrives in S1-B; this shell proves the
 * process boots without HTTP.
 */
export function createWorkerRootModule(config: CogetoConfig): unknown {
  @Module({
    imports: [
      DatabaseModule.register({ databaseUrl: config.databaseUrl }),
      ModelGatewayModule.register({ mistralApiKey: config.mistralApiKey }),
      MemoryModule,
      IngestionModule,
      AgentsModule,
      ConnectorsModule,
      TasksModule,
    ],
    providers: [{ provide: COGETO_CONFIG, useValue: config }],
  })
  class WorkerRootModule {}

  return WorkerRootModule;
}
