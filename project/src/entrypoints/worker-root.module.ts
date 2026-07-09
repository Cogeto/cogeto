import { Module } from '@nestjs/common';
import { DatabaseModule } from '../infrastructure/index';
import { IdentityModule } from '../identity/index';
import { MemoryModule } from '../memory/index';
import { IngestionModule } from '../ingestion/index';
import { AgentsModule } from '../agents/index';
import {
  ConnectorsModule,
  FileSourceReader,
  NotesSourceDeletion,
  NotesSourceReader,
} from '../connectors/index';
import { TasksCascade, TasksModule } from '../tasks/index';
import { ChatSourceDeletion, ChatSourceModule, ChatSourceReader } from '../retrieval/index';
import { ModelGatewayModule } from '../model-gateway/index';
import { COGETO_CONFIG } from './config';
import type { CogetoConfig } from './config';

/**
 * Composition root of the worker process — all slow-path jobs (§A.1): the
 * ingestion pipeline, reconciliation, deletion sagas, reminders, approved-action
 * execution. This is where ingestion's source-reader port meets the connector
 * implementations — the only place allowed to know both sides.
 */
export function createWorkerRootModule(config: CogetoConfig): unknown {
  @Module({
    imports: [
      DatabaseModule.register({ databaseUrl: config.databaseUrl }),
      // The worker serves no HTTP, but domain modules carry controllers whose
      // guards Nest resolves at init — the identity seam must be present here too.
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
          publicUrl: config.s3PublicUrl,
          accessKey: config.s3AccessKey,
          secretKey: config.s3SecretKey,
          bucket: config.s3Bucket,
        },
        instanceKeyDir: config.instanceKeyDir,
        // The chat source deletion joins notes' so a chat-derived memory's source
        // deletion erases the originating turn under the saga (decision 0021 r7).
        sourceDeletions: { adapters: [NotesSourceDeletion, ChatSourceDeletion] },
        derivedCascades: { imports: [TasksModule.register()], adapters: [TasksCascade] },
      }),
      // ChatSourceReader gives ingestion a stage-1 reader for source_type 'chat'.
      IngestionModule.register({
        readers: [NotesSourceReader, FileSourceReader, ChatSourceReader],
      }),
      ChatSourceModule,
      AgentsModule,
      ConnectorsModule.register({
        fileUpload: {
          uploadMaxBytes: config.uploadMaxBytes,
          downloadUrlTtlSeconds: config.downloadUrlTtlSeconds,
        },
      }),
      TasksModule.register(),
    ],
    providers: [{ provide: COGETO_CONFIG, useValue: config }],
  })
  class WorkerRootModule {}

  return WorkerRootModule;
}
