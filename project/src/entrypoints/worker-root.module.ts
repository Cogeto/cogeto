import { Module } from '@nestjs/common';
import { DatabaseModule, LimitsModule } from '../infrastructure/index';
import { IdentityModule } from '../identity/index';
import { MemoryModule } from '../memory/index';
import { IngestionModule, PipelineIngestionGuard } from '../ingestion/index';
import { AgentsModule } from '../agents/index';
import {
  ConnectorsModule,
  FileSourceReader,
  NotesSourceDeletion,
  NotesSourceReader,
} from '../connectors/index';
import { TasksCascade, TasksModule } from '../tasks/index';
import {
  ChatAnswerCascade,
  ChatSourceDeletion,
  ChatSourceModule,
  ChatSourceReader,
} from '../retrieval/index';
import { ModelGatewayModule } from '../model-gateway/index';
import { COGETO_CONFIG, redactionOptions } from './config';
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
      DatabaseModule.register({ databaseUrl: config.databaseUrl, poolMax: config.pgPoolMax }),
      // Limits (FIX-2): the worker needs the parse caps (QS-6) for the pipeline
      // + file source reader. Its model calls are unattributed, so the model
      // budget is off here (ModelGatewayModule without `budget`).
      LimitsModule.register(config.limits, config.timezone),
      // The worker serves no HTTP, but domain modules carry controllers whose
      // guards Nest resolves at init — the identity seam must be present here too.
      IdentityModule.register({
        internalBaseUrl: config.oidc.internalUrl,
        externalDomain: config.oidc.externalDomain,
        cacheTtlSeconds: 10, // QS-11 (the worker serves no HTTP; parity only)
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
        // The chat source deletion joins notes' so a chat-derived memory's source
        // deletion erases the originating turn under the saga (decision 0021 r7).
        sourceDeletions: { adapters: [NotesSourceDeletion, ChatSourceDeletion] },
        derivedCascades: {
          imports: [TasksModule.register(), ChatSourceModule],
          // Tasks are deleted with their memories; assistant answers citing
          // erased memories are redacted (QS-7, decision 0025).
          adapters: [TasksCascade, ChatAnswerCascade],
        },
        // Delete-vs-ingestion serialization (QS-5, decision 0024): the saga
        // cancels a source's pending pipeline run inside its enumeration tx.
        ingestionGuard: PipelineIngestionGuard,
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
