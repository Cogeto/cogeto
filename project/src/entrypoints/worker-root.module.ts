import { Module } from '@nestjs/common';
import {
  DatabaseModule,
  DEFAULT_INSTANCE_TIMEZONE,
  INSTANCE_TIMEZONE,
  LimitsModule,
  UserContextModule,
  UserContextService,
} from '../infrastructure/index';
import { IdentityModule } from '../identity/index';
import { MemoryModule } from '../memory/index';
import {
  IngestionModule,
  PipelineIngestionGuard,
  SuppressedFactCascade,
  SuppressedFactCascadeModule,
} from '../ingestion/index';
import { AgentsModule, ReplyDraftCascade, ReplyDraftCascadeModule } from '../agents/index';
import { ConnectorsModule, SKILL_ADVANCE_JOB_TYPE } from '../connectors/index';
import {
  RESEARCH_SYNTHESIS_OPTIONS,
  ResearchModule,
  ResearchSynthesisService,
  WebSourceDeletion,
  WebSourceReader,
} from '../research/index';
import { EmailModule, EmailSourceDeletion, EmailSourceReader } from '../email/index';
import { FilesModule, FileSourceReader } from '../files/index';
import { NotesModule, NotesSourceDeletion, NotesSourceReader } from '../notes/index';
import type { ResearchSynthesisOptions } from '../research/index';
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
  CONVERSATION_APPEND,
  ConversationSourceDeletion,
} from '../retrieval/index';
import type { ConversationAppendPort } from '../retrieval/index';
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
  // ONE dynamic instance per family module, threaded everywhere it is needed
  // (the root's import list AND the registration options of the modules that
  // bind its port adapters). Registering twice would duplicate controllers
  // and providers; this hoisted-instance pattern is the part-4 replacement
  // for globality.
  const filesModule = FilesModule.register({
    fileUpload: {
      uploadMaxBytes: config.uploadMaxBytes,
      downloadUrlTtlSeconds: config.downloadUrlTtlSeconds,
    },
  });
  const emailModule = EmailModule.register({ mail: mailOptions(config) });
  const researchModule = ResearchModule.register({
    research: researchOptions(config),
    skillAdvance: { skillAdvanceJobType: SKILL_ADVANCE_JOB_TYPE },
  });
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
      // No longer global (boundary contract §4): imported here for this root's
      // own ResearchSynthesisService, and separately by every module that
      // injects it.
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
          // Each adapter's family module is named here; the remaining
          // connector adapters still resolve from the global ConnectorsModule
          // (B14, closing family by family in part 4).
          imports: [ChatSourceModule, NotesModule, emailModule, researchModule],
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
          imports: [
            ChatSourceModule,
            ReplyDraftCascadeModule,
            PassportCascadeModule,
            SuppressedFactCascadeModule,
          ],
          // Assistant answers citing erased memories are redacted (
          //); reply drafts grounded on the source are too. A ready passport
          // export is a signed copy of everything the owner could see, so it is
          // expired by the same receipt (SEC-8).
          // The suppressed-fact log is content-bearing (V2.0 item 3.3): the
          // claim as extracted and its exact span. It joins the cascade so the
          // receipt's erasure claim stays complete.
          adapters: [
            ChatAnswerCascade,
            ReplyDraftCascade,
            PassportExportCascade,
            SuppressedFactCascade,
          ],
        },
        // Delete-vs-ingestion serialization: the saga
        // cancels a source's pending pipeline run inside its enumeration tx.
        ingestionGuard: PipelineIngestionGuard,
      }),
      // ChatSourceReader gives ingestion a stage-1 reader for source_type 'chat';
      // EmailSourceReader adds source_type 'email';
      // WebSourceReader adds 'web'.
      IngestionModule.register({
        // Each reader's family module is named here; the remaining connector
        // readers still resolve from the global ConnectorsModule (B14).
        imports: [ChatSourceModule, NotesModule, filesModule, emailModule, researchModule],
        readers: [
          NotesSourceReader,
          FileSourceReader,
          ChatSourceReader,
          EmailSourceReader,
          WebSourceReader,
        ],
      }),
      ChatSourceModule,
      NotesModule,
      AgentsModule,
      filesModule,
      emailModule,
      researchModule,
      ConnectorsModule.register({ imports: [researchModule] }),
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
      // deliberately absent in this process — the named-options seam makes the
      // stored answer web-only ([W#]), while the app's ResearchChatModule
      // instance keeps memory citations for interactive synthesis.
      ResearchSynthesisService,
      // The synthesis collaborators, by TOKEN into a named bag (V2.0 item 3.6
      // part 4). `retrieval` is DELIBERATELY absent in this root — stated
      // here rather than implied by resolution order — and the factory
      // asserts what the worker DOES require, so a wiring regression fails
      // boot instead of silently degrading conclusion phrasing.
      {
        provide: RESEARCH_SYNTHESIS_OPTIONS,
        useFactory: (
          userContext: UserContextService,
          conversationAppend: ConversationAppendPort,
          timeZone?: string,
        ): ResearchSynthesisOptions => {
          if (!userContext || !conversationAppend) {
            throw new Error(
              'worker root: synthesis wiring incomplete (userContext/conversationAppend)',
            );
          }
          return {
            userContext,
            conversationAppend,
            instanceTimeZone: timeZone ?? DEFAULT_INSTANCE_TIMEZONE,
          };
        },
        inject: [
          UserContextService,
          CONVERSATION_APPEND,
          { token: INSTANCE_TIMEZONE, optional: true },
        ],
      },
    ],
  })
  class WorkerRootModule {}

  return WorkerRootModule;
}
