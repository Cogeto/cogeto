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
import { PassportModule, PASSPORT_EXPORT_RETENTION_HOURS } from '../passport/index';
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
 * Composition root of the worker process — all slow-path jobs (§A.1): the
 * ingestion pipeline, reconciliation, deletion sagas, approved-action
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
      // Per-user context + language (P6.6): the worker's system-initiated
      // copy (digest lines, conclusion phrasing) speaks preferred_language.
      UserContextModule,
      // The worker serves no HTTP, but domain modules carry controllers whose
      // guards Nest resolves at init — the identity seam must be present here too.
      IdentityModule.register({
        internalBaseUrl: config.oidc.internalUrl,
        externalDomain: config.oidc.externalDomain,
        cacheTtlSeconds: 10, // QS-11 (the worker serves no HTTP; parity only)
      }),
      ModelGatewayModule.register({
        providers: config.modelProviders,
        redaction: redactionOptions(config),
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
        // deletion erases the originating turn under the saga (decision 0021 r7).
        sourceDeletions: {
          adapters: [
            NotesSourceDeletion,
            ChatSourceDeletion,
            // A whole conversation is a deletable source (P6.9, decision 0056).
            ConversationSourceDeletion,
            EmailSourceDeletion,
            // Web pages are deletable sources (Priority 5 Part A, 0043).
            WebSourceDeletion,
          ],
        },
        derivedCascades: {
          imports: [ChatSourceModule, ReplyDraftCascadeModule],
          // Assistant answers citing erased memories are redacted (QS-7,
          // decision 0025); reply drafts grounded on the source are too (SEC-4).
          adapters: [ChatAnswerCascade, ReplyDraftCascade],
        },
        // Delete-vs-ingestion serialization (QS-5, decision 0024): the saga
        // cancels a source's pending pipeline run inside its enumeration tx.
        ingestionGuard: PipelineIngestionGuard,
      }),
      // ChatSourceReader gives ingestion a stage-1 reader for source_type 'chat';
      // EmailSourceReader adds source_type 'email' (Session O4);
      // WebSourceReader adds 'web' (Priority 5 Part A, decision 0043).
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
      // The Memory Passport export + retention jobs run here (§A.3 slow path);
      // the worker holds the private signing key to sign each manifest.
      PassportModule.register({
        instanceKeyDir: config.instanceKeyDir,
        downloadUrlTtlSeconds: config.downloadUrlTtlSeconds,
        exportRetentionHours: PASSPORT_EXPORT_RETENTION_HOURS,
      }),
    ],
    providers: [
      { provide: COGETO_CONFIG, useValue: config },
      // The worker's synthesis for server-side research conclusion (decision
      // 0057): composed HERE (not in ConnectorsModule) because retrieval is
      // deliberately absent in this process — the @Optional seam makes the
      // stored answer web-only ([W#]), while the app's ResearchChatModule
      // instance keeps memory citations for interactive synthesis.
      ResearchSynthesisService,
    ],
  })
  class WorkerRootModule {}

  return WorkerRootModule;
}
