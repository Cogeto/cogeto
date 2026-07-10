import { Module } from '@nestjs/common';
import { DatabaseModule } from '../infrastructure/index';
import { IdentityModule } from '../identity/index';
import { IngestionModule } from '../ingestion/index';
import { MemoryModule } from '../memory/index';
import { ChatSourceDeletion, ChatSourceModule, RetrievalModule } from '../retrieval/index';
import { AgentsModule } from '../agents/index';
import { ConnectorsModule, NotesSourceDeletion } from '../connectors/index';
import { TasksCascade, TasksModule } from '../tasks/index';
import { ModelGatewayModule } from '../model-gateway/index';
import { COGETO_CONFIG, redactionOptions } from './config';
import type { CogetoConfig } from './config';
import { AuditController } from './audit.controller';
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
        redaction: redactionOptions(config),
      }),
      MemoryModule.register({
        qdrantUrl: config.qdrantUrl,
        embeddingModel: config.mistralEmbedModel,
        s3: {
          url: config.s3Url,
          publicUrl: config.s3PublicUrl,
          accessKey: config.s3AccessKey,
          secretKey: config.s3SecretKey,
          bucket: config.s3Bucket,
        },
        instanceKeyDir: config.instanceKeyDir,
        // Chat joins notes as a deletable source (decision 0021 r7) — the
        // source-delete endpoint runs the saga for a chat-derived memory too.
        sourceDeletions: { adapters: [NotesSourceDeletion, ChatSourceDeletion] },
        derivedCascades: { imports: [TasksModule.forApi()], adapters: [TasksCascade] },
      }),
      RetrievalModule,
      ChatSourceModule, // the chat source-deletion adapter for the delete endpoint
      IngestionModule.forQueries(), // verification + dreaming read endpoints
      AgentsModule,
      ConnectorsModule.register({
        fileUpload: {
          uploadMaxBytes: config.uploadMaxBytes,
          downloadUrlTtlSeconds: config.downloadUrlTtlSeconds,
        },
      }),
      TasksModule.forApi(),
      // The digest's TASKS section as a global provider, so ingestion's digest
      // endpoint can inject it without importing tasks (O2-A; F3 handoff §3).
      TasksModule.forDigest(),
    ],
    controllers: [
      AuditController,
      HealthController,
      InstanceController,
      JobsController,
      WebConfigController,
    ],
    providers: [{ provide: COGETO_CONFIG, useValue: config }],
  })
  class AppRootModule {}

  return AppRootModule;
}
