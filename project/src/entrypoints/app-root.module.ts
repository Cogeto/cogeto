import { Module } from '@nestjs/common';
import { DatabaseModule } from '../infrastructure/index';
import { IdentityModule } from '../identity/index';
import { IngestionModule } from '../ingestion/index';
import { MemoryModule } from '../memory/index';
import { RetrievalModule } from '../retrieval/index';
import { AgentsModule } from '../agents/index';
import { ConnectorsModule, NotesSourceDeletion } from '../connectors/index';
import { TasksCascade, TasksModule } from '../tasks/index';
import { ModelGatewayModule } from '../model-gateway/index';
import { COGETO_CONFIG } from './config';
import type { CogetoConfig } from './config';
import { HealthController } from './health.controller';
import { InstanceController } from './instance.controller';
import { JobsController } from './jobs.controller';
import { WebConfigController } from './web-config.controller';

/**
 * Composition root of the app process (fast path only: API, dashboard,
 * connectors' HTTP surface, approval endpoints). Declarative wiring only —
 * "initialize everything inline" erosion is the known failure mode
 * (research: project-structure-lessons §1).
 */
export function createAppRootModule(config: CogetoConfig): unknown {
  @Module({
    imports: [
      DatabaseModule.register({ databaseUrl: config.databaseUrl }),
      IdentityModule.register({
        internalBaseUrl: config.oidc.internalUrl,
        externalDomain: config.oidc.externalDomain,
        cacheTtlSeconds: 60,
      }),
      ModelGatewayModule.register({
        mistralApiKey: config.mistralApiKey,
        pipelineModel: config.mistralPipelineModel,
        answerModel: config.mistralAnswerModel,
        embedModel: config.mistralEmbedModel,
      }),
      MemoryModule.register({
        qdrantUrl: config.qdrantUrl,
        embeddingModel: config.mistralEmbedModel,
        s3: {
          url: config.s3Url,
          accessKey: config.s3AccessKey,
          secretKey: config.s3SecretKey,
          bucket: config.s3Bucket,
        },
        instanceKeyDir: config.instanceKeyDir,
        sourceDeletions: { imports: [ConnectorsModule], adapters: [NotesSourceDeletion] },
        derivedCascades: { imports: [TasksModule.forApi()], adapters: [TasksCascade] },
      }),
      RetrievalModule,
      IngestionModule.forQueries(), // verification + dreaming read endpoints
      AgentsModule,
      ConnectorsModule,
      TasksModule.forApi(),
    ],
    controllers: [HealthController, InstanceController, JobsController, WebConfigController],
    providers: [{ provide: COGETO_CONFIG, useValue: config }],
  })
  class AppRootModule {}

  return AppRootModule;
}
