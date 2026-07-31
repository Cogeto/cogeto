import { Module } from '@nestjs/common';
import { DatabaseModule, LimitsModule, UserContextModule } from '../infrastructure/index';
import { IdentityModule } from '../identity/index';
import { MemoryModule } from '../memory/index';
import { IngestionModule, PipelineIngestionGuard } from '../ingestion/index';
import { AgentsModule, ReplyDraftCascade, ReplyDraftCascadeModule } from '../agents/index';
import {
  ConnectorsModule,
  EmailSourceDeletion,
  EmailSourceReader,
  FileSourceReader,
  NotesSourceDeletion,
  NotesSourceReader,
  ResearchSynthesisService,
  WebSourceDeletion,
  WebSourceReader,
} from '../connectors/index';
import {
  PassportCascadeModule,
  PassportExportCascade,
  PassportModule,
  PASSPORT_EXPORT_RETENTION_HOURS,
} from '../passport/index';
import {
  ChatAnswerCascade,
  ChatSourceDeletion,
  ChatSourceModule,
  ChatSourceReader,
  ConversationSourceDeletion,
} from '../retrieval/index';
import { ModelGatewayModule } from '../model-gateway/index';
import { COGETO_CONFIG, mailOptions, redactionOptions, researchOptions } from './config';
import type { CogetoConfig } from './config';

/**
 * Composition root of the worker process — all slow-path jobs (spec §15): the
 * ingestion pipeline, reconciliation, deletion sagas, approved-action
 * execution. This is where ingestion's source-reader port meets the connector
 * implementations — the only place allowed to know both sides.
 */
export function createWorkerRootModule(config: CogetoConfig): unknown {
  @Module({
    imports: [
      DatabaseModule.register({ databaseUrl: config.databaseUrl, poolMax: config.pgPoolMax }),
      // Limits: the parse caps for the pipeline + file source reader, and
      // (audit 2.0 SEC-18) the DURABLE counters the model budget reads. The
      // counters live in Postgres, so the app and this process enforce one
      // shared daily total rather than a per-process half that a restart wipes.
      LimitsModule.register(config.limits, config.timezone),
      // Per-user context + language: the worker's system-initiated
      // copy (digest lines, conclusion phrasing) speaks preferred_language.
      UserContextModule,
      // The worker serves no HTTP, but domain modules carry controllers whose
      // guards Nest resolves at init — the identity seam must be present here too.
      IdentityModule.register({
        internalBaseUrl: config.oidc.internalUrl,
        externalDomain: config.oidc.externalDomain,
        cacheTtlSeconds: 10, // (the worker serves no HTTP; parity only)
      }),
      ModelGatewayModule.register({
        providers: config.modelProviders,
        redaction: redactionOptions(config),
        // SEC-10: worker model traffic was entirely unmetered — this root
        // omitted the budget wrapper, so extraction, verification, embedding,
        // dreaming, skill advance and research conclusion ran with no daily
        // ceiling at all. The wrapper is on, and the task wrapper opens a usage
        // scope from the enqueuing principal so the spend has an owner.
        budget: true,
      }),
      MemoryModule.register({
        qdrantUrl: config.qdrantUrl,
        qdrantApiKey: config.qdrantApiKey,
        embeddingModel: config.modelProviders.tiers.embedding.model,
        s3: {
          url: config.s3Url,
          publicUrl: config.s3PublicUrl,
          accessKey: config.s3AccessKey,
          secretKey: config.s3SecretKey,
          bucket: config.s3Bucket,
        },
        instanceKeyDir: config.instanceKeyDir,
        // The chat source deletion joins notes' so a chat-derived memory's source
        // deletion erases the originating turn under the saga (r7).
        sourceDeletions: {
          adapters: [
            NotesSourceDeletion,
            ChatSourceDeletion,
            // A whole conversation is a deletable source.
            ConversationSourceDeletion,
            EmailSourceDeletion,
            // Web pages are deletable sources (0043).
            WebSourceDeletion,
          ],
        },
        derivedCascades: {
          imports: [ChatSourceModule, ReplyDraftCascadeModule, PassportCascadeModule],
          // Assistant answers citing erased memories are redacted (
          //); reply drafts grounded on the source are too. A ready passport
          // export is a signed copy of everything the owner could see, so it is
          // expired by the same receipt (SEC-8).
          adapters: [ChatAnswerCascade, ReplyDraftCascade, PassportExportCascade],
        },
        // Delete-vs-ingestion serialization: the saga
        // cancels a source's pending pipeline run inside its enumeration tx.
        ingestionGuard: PipelineIngestionGuard,
      }),
      // ChatSourceReader gives ingestion a stage-1 reader for source_type 'chat';
      // EmailSourceReader adds source_type 'email';
      // WebSourceReader adds 'web'.
      IngestionModule.register({
        readers: [
          NotesSourceReader,
          FileSourceReader,
          ChatSourceReader,
          EmailSourceReader,
          WebSourceReader,
        ],
      }),
      ChatSourceModule,
      AgentsModule,
      ConnectorsModule.register({
        fileUpload: {
          uploadMaxBytes: config.uploadMaxBytes,
          downloadUrlTtlSeconds: config.downloadUrlTtlSeconds,
        },
        mail: mailOptions(config),
        research: researchOptions(config),
      }),
      // The Memory Passport export + retention jobs run here (spec §15.4 slow path);
      // the worker holds the private signing key to sign each manifest.
      PassportModule.register({
        instanceKeyDir: config.instanceKeyDir,
        downloadUrlTtlSeconds: config.downloadUrlTtlSeconds,
        exportRetentionHours: PASSPORT_EXPORT_RETENTION_HOURS,
      }),
    ],
    providers: [
      { provide: COGETO_CONFIG, useValue: config },
      // The worker's synthesis for server-side research conclusion : composed HERE (not in ConnectorsModule) because retrieval is
      // deliberately absent in this process — the @Optional seam makes the
      // stored answer web-only ([W#]), while the app's ResearchChatModule
      // instance keeps memory citations for interactive synthesis.
      ResearchSynthesisService,
    ],
  })
  class WorkerRootModule {}

  return WorkerRootModule;
}
