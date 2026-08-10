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
  ExtractionRefusalCascade,
  ExtractionRefusalCascadeModule,
  IngestionModule,
  IngestionProgressCascade,
  IngestionProgressCascadeModule,
  SourceRevisionCascade,
  SourceRevisionCascadeModule,
  SourceContextCascade,
  SourceContextCascadeModule,
  PipelineIngestionGuard,
  SuppressedFactCascade,
  SuppressedFactCascadeModule,
} from '../ingestion/index';
import { AgentsModule, ReplyDraftCascade, ReplyDraftCascadeModule } from '../agents/index';
import { SKILL_ADVANCE_JOB_TYPE, SkillsModule } from '../skills/index';
import {
  RESEARCH_SYNTHESIS_OPTIONS,
  ResearchModule,
  ResearchSourcePortsModule,
  ResearchSynthesisService,
  WebSourceDeletion,
  WebSourceReader,
} from '../research/index';
import {
  EmailModule,
  EmailSourceDeletion,
  EmailSourcePortsModule,
  EmailSourceReader,
} from '../email/index';
import {
  FileReadReportCascade,
  FileReadReportCascadeModule,
  FilesModule,
  FileSourceReader,
} from '../files/index';
import {
  NotesModule,
  NotesSourceDeletion,
  NotesSourcePortsModule,
  NotesSourceReader,
} from '../notes/index';
import { SettingsModule } from '../settings/index';
import type { ResearchSynthesisOptions } from '../research/index';
import {
  PassportCascadeModule,
  PassportExportCascade,
  PassportModule,
  PASSPORT_EXPORT_RETENTION_HOURS,
} from '../passport/index';
import { ImportItemCascade, ImportItemCascadeModule, ImportsModule } from '../imports/index';
import {
  FindingsReportCascade,
  FindingsReportCascadeModule,
  ReportsModule,
  REPORT_RETENTION_HOURS,
} from '../reports/index';
import {
  ChatAnswerCascade,
  ChatAttachmentCascade,
  ChatAttachmentWorkerModule,
  ChatSourceDeletion,
  ChatSourceModule,
  ChatSourceReader,
  CONVERSATION_APPEND,
  ConversationSourceDeletion,
} from '../chat/index';
import type { ConversationAppendPort } from '../chat/index';
import { ModelGatewayModule } from '../model-gateway/index';
import type { LiveModelConfiguration } from '../model-gateway/index';
import { ProvidersModule } from '../providers/index';
import { COGETO_CONFIG, mailOptions, redactionOptions, researchOptions } from './config';
import type { CogetoConfig } from './config';

/**
 * Composition root of the worker process — all slow-path jobs (spec §15): the
 * ingestion pipeline, reconciliation, deletion sagas, approved-action
 * execution. This is where ingestion's source-reader port meets the connector
 * implementations — the only place allowed to know both sides.
 */
export function createWorkerRootModule(
  config: CogetoConfig,
  live: LiveModelConfiguration,
): unknown {
  // The instance's model configuration (V2.4 item 7.1). The worker registers
  // no controllers — it serves no HTTP — but it does watch: an assignment an
  // admin saves in the app must reach background processing without a restart,
  // and this process has no request to notice it on.
  const providersModule = ProvidersModule.register({
    live,
    masterKey: config.masterKey,
    redacted: config.redactionEnabled,
    reasoningHeadroom: config.modelProviders.reasoningHeadroom,
    timeoutsMs: config.modelProviders.timeoutsMs,
    trustScoresDir: config.trustScoresDir,
    pollIntervalMs: 30_000,
    controllers: false,
  });
  // ONE dynamic instance per family module, threaded everywhere it is needed
  // (the root's import list AND the registration options of the modules that
  // bind its port adapters). Registering twice would duplicate controllers
  // and providers; this hoisted-instance pattern is the part-4 replacement
  // for globality.
  const memoryModule = MemoryModule.register({
    qdrantUrl: config.qdrantUrl,
    qdrantApiKey: config.qdrantApiKey,
    embeddingModel: config.modelProviders.tiers.embedding.model,
    // The LIVE object (V2.4 item 7.1): the vector store resolves the active
    // collection from the index state and re-resolves when the configuration
    // version moves, which is how a completed rebuild's switch reaches this
    // process without a restart.
    modelProviders: config.modelProviders,
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
      // The slim source-ports modules (the ChatSourceModule shape): db-only
      // providers, so memory never imports a family that imports memory back.
      imports: [
        ChatSourceModule,
        NotesSourcePortsModule,
        EmailSourcePortsModule,
        ResearchSourcePortsModule,
      ],
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
        ExtractionRefusalCascadeModule,
        SourceContextCascadeModule,
        FileReadReportCascadeModule,
        IngestionProgressCascadeModule,
        SourceRevisionCascadeModule,
        ImportItemCascadeModule,
        FindingsReportCascadeModule,
      ],
      // Assistant answers citing erased memories are redacted; reply drafts
      // grounded on the source are too. A ready passport export is a signed
      // copy of everything the owner could see, so it is expired by the same
      // receipt (SEC-8). The suppressed-fact log is content-bearing (V2.0
      // item 3.3) and joins so the receipt's erasure claim stays complete.
      adapters: [
        ChatAnswerCascade,
        ReplyDraftCascade,
        PassportExportCascade,
        SuppressedFactCascade,
        // The gate refusal ledger is metadata-only, but a refusal row for an
        // erased source is a dangling provenance reference (V2.1 item 4.3).
        ExtractionRefusalCascade,
        // The source context is the document's own words (V2.1 item 4.2).
        SourceContextCascade,
        // The file read report is content-bearing (sheet names) and can exist
        // with no memory at all, so it goes with its source (V2.1 item 4.1).
        FileReadReportCascade,
        // Conversation attachments (V2.2 item 5.1): rows go with their
        // conversation; a durable link to an erased file loses its filename.
        ChatAttachmentCascade,
        // The pipeline stage row is metadata-only hygiene, like the refusals.
        IngestionProgressCascade,
        // A revision link naming an erased source goes with it (V2.2 5.3).
        SourceRevisionCascade,
        // An import item's filename dies with its source: tombstoned.
        ImportItemCascade,
        // A findings report quotes verbatim spans: the second content-bearing
        // artifact under the passport's SEC-8 rule (V2.3 item 6.2).
        FindingsReportCascade,
      ],
    },
    // Delete-vs-ingestion serialization: the saga cancels a source's pending
    // pipeline run inside its enumeration tx.
    ingestionGuard: PipelineIngestionGuard,
    // The unscoped machine reads (V2.0 item 3.7). ONLY here: this process runs
    // the nightly dreaming cycle and the skill advance job, which read across
    // every owner by nature. The app root deliberately omits it, so
    // MemorySystemStore is not resolvable in the process that serves requests.
    systemReads: true,
  });
  const settingsModule = SettingsModule.register({ imports: [memoryModule] });
  const notesModule = NotesModule.register({ imports: [settingsModule] });
  const filesModule = FilesModule.register({
    fileUpload: {
      uploadMaxBytes: config.uploadMaxBytes,
      downloadUrlTtlSeconds: config.downloadUrlTtlSeconds,
    },
    // The reading ladder's vision tier (V2.1 item 4.1) is wired in the WORKER
    // only: reading a page with a model is slow-path ingestion work, and the
    // app process has no business making an image call on a request.
    modelProviders: config.modelProviders,
    imports: [memoryModule, settingsModule],
  });
  const emailModule = EmailModule.register({
    mail: mailOptions(config),
    imports: [memoryModule, settingsModule],
  });
  const researchModule = ResearchModule.register({
    research: researchOptions(config),
    skillAdvance: { skillAdvanceJobType: SKILL_ADVANCE_JOB_TYPE },
    imports: [memoryModule],
  });
  const skillsModule = SkillsModule.register({ imports: [memoryModule, researchModule] });
  // One imports instance, threaded to the root AND to reports (V2.3 item
  // 6.2): the report assembler reads an import-scope run's record.
  const importsModule = ImportsModule.forWorker({
    inFlight: config.importInFlight,
    imports: [memoryModule, filesModule],
  });
  const agentsModule = AgentsModule.register({ imports: [memoryModule] });
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
        // The gateway follows the live configuration (V2.4 item 7.1).
        live,
        redaction: redactionOptions(config),
        // SEC-10: worker model traffic was entirely unmetered — this root
        // omitted the budget wrapper, so extraction, verification, embedding,
        // dreaming, skill advance and research conclusion ran with no daily
        // ceiling at all. The wrapper is on, and the task wrapper opens a usage
        // scope from the enqueuing principal so the spend has an owner.
        budget: true,
      }),
      providersModule,
      memoryModule,
      // ChatSourceReader gives ingestion a stage-1 reader for source_type 'chat';
      // EmailSourceReader adds source_type 'email';
      // WebSourceReader adds 'web'.
      IngestionModule.register({
        // Each reader's ports module is named here; FileSourceReader needs
        // memory's stores, so the files family instance carries it (B13).
        imports: [
          memoryModule,
          ChatSourceModule,
          NotesSourcePortsModule,
          filesModule,
          EmailSourcePortsModule,
          ResearchSourcePortsModule,
        ],
        readers: [
          NotesSourceReader,
          FileSourceReader,
          ChatSourceReader,
          EmailSourceReader,
          WebSourceReader,
        ],
        // The generation binding the checked-pair ledger records beside every
        // verdict (V2.3 item 6.1): a model change re-opens judged pairs.
        // A GETTER, not a captured string (V2.4 item 7.1): the pipeline
        // binding can change while this process runs, and a stale label would
        // let the ledger skip re-judging pairs under a model that changed.
        reconcileModelConfig: () =>
          `${config.modelProviders.tiers.pipeline.provider}/${config.modelProviders.tiers.pipeline.model}`,
      }),
      ChatSourceModule,
      // The transient attachment read job (V2.2 item 5.1): needs memory's
      // object store and files' laddered reader, so it lives in its own
      // module and receives the two family instances explicitly.
      ChatAttachmentWorkerModule.register({ imports: [memoryModule, filesModule] }),
      // The bulk-import coordinator (V2.2 item 5.3): ingests through files'
      // one upload path at demoted priority, bounded in flight.
      importsModule,
      // The findings-report generation + retention jobs (V2.3 item 6.2, spec
      // §15.4 slow path); the worker holds the private key to sign each
      // payload hash, exactly as it signs receipts and passport manifests.
      ReportsModule.forWorker({
        instanceKeyDir: config.instanceKeyDir,
        downloadUrlTtlSeconds: config.downloadUrlTtlSeconds,
        exportRetentionHours: REPORT_RETENTION_HOURS,
        fontsDir: config.reportFontsDir,
        brandDir: config.reportBrandDir,
        trustScoresDir: config.trustScoresDir,
        // GETTERS, not a snapshot (V2.4 item 7.1): a report states the
        // configuration it was generated under, and since an assignment can
        // change while this process runs, a copy taken at boot would put a
        // configuration id in a SIGNED artifact that was not the one in force.
        modelConfig: {
          get id() {
            return config.modelProviders.id;
          },
          get tiers() {
            return {
              pipeline: {
                provider: config.modelProviders.tiers.pipeline.provider,
                model: config.modelProviders.tiers.pipeline.model,
              },
              answer: {
                provider: config.modelProviders.tiers.answer.provider,
                model: config.modelProviders.tiers.answer.model,
              },
              embedding: {
                provider: config.modelProviders.tiers.embedding.provider,
                model: config.modelProviders.tiers.embedding.model,
              },
            };
          },
          get vision() {
            return config.modelProviders.vision
              ? {
                  provider: config.modelProviders.vision.provider,
                  model: config.modelProviders.vision.model,
                }
              : null;
          },
          get redactionEnabled() {
            return config.modelProviders.redacted;
          },
        },
        imports: [memoryModule, importsModule],
      }),
      notesModule,
      settingsModule,
      agentsModule,
      filesModule,
      emailModule,
      researchModule,
      skillsModule,
      // The Memory Passport export + retention jobs run here (spec §15.4 slow path);
      // the worker holds the private signing key to sign each manifest.
      PassportModule.register({
        instanceKeyDir: config.instanceKeyDir,
        downloadUrlTtlSeconds: config.downloadUrlTtlSeconds,
        exportRetentionHours: PASSPORT_EXPORT_RETENTION_HOURS,
        imports: [memoryModule],
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
