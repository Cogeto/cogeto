import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { DatabaseModule, LimitsModule } from '../infrastructure/index';
import { IdentityModule } from '../identity/index';
import { ModelBudgetExceptionFilter } from './model-budget.filter';
import { IngestionModule, PipelineIngestionGuard } from '../ingestion/index';
import { MemoryModule } from '../memory/index';
import {
  ChatAnswerCascade,
  ChatSourceDeletion,
  ChatSourceModule,
  RetrievalModule,
} from '../retrieval/index';
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
      // Abuse/DoS limits (FIX-2) — global, so the rate-limit guard, ingest
      // quota, SSE caps and model budget are injectable across controllers.
      LimitsModule.register(config.limits),
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
        // Enforce the per-user daily model budget on the app's user-attributed
        // calls (QS-2); the worker registers this without budget.
        budget: true,
      }),
      MemoryModule.register({
        qdrantUrl: config.qdrantUrl,
        qdrantApiKey: config.qdrantApiKey,
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
        derivedCascades: {
          imports: [TasksModule.forApi(), ChatSourceModule],
          // Tasks are deleted with their memories; assistant answers citing
          // erased memories are redacted (QS-7, decision 0025).
          adapters: [TasksCascade, ChatAnswerCascade],
        },
        // Delete-vs-ingestion serialization (QS-5, decision 0024): the saga
        // cancels a source's pending pipeline run inside its enumeration tx.
        ingestionGuard: PipelineIngestionGuard,
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
    providers: [
      { provide: COGETO_CONFIG, useValue: config },
      // Map a spent daily model budget to HTTP 429 for non-stream endpoints
      // (QS-2); the chat SSE path surfaces it as a distinct error event instead.
      { provide: APP_FILTER, useClass: ModelBudgetExceptionFilter },
    ],
  })
  class AppRootModule {}

  return AppRootModule;
}
