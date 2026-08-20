import { readFileSync } from 'node:fs';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { DatabaseModule, LimitsModule, UserContextModule } from '../infrastructure/index';
import { BearerAuthGuard, IdentityModule } from '../identity/index';
import { ModelBudgetExceptionFilter } from './model-budget.filter';
import {
  EntityAliasSpaceCleanup,
  EntityAliasSpaceCleanupModule,
  ExtractionGateSpaceCleanup,
  ExtractionGateSpaceCleanupModule,
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
  ReconcileRepairEligibilityHook,
  SuppressedFactCascade,
  SuppressedFactCascadeModule,
} from '../ingestion/index';
import { MemoryModule } from '../memory/index';
import { RetrievalModule } from '../retrieval/index';
import {
  ImportItemCascade,
  ImportItemCascadeModule,
  ImportSpaceCleanup,
  ImportSpaceCleanupModule,
} from '../imports/index';
import {
  ChatAnswerCascade,
  ChatAttachmentCascade,
  ChatModule,
  ChatService,
  ChatSourceDeletion,
  ChatSourceModule,
  ConversationSourceDeletion,
} from '../chat/index';
import {
  AgentsModule,
  AgentsSpaceCleanup,
  AgentsSpaceCleanupModule,
  ReplyDraftCascade,
  ReplyDraftCascadeModule,
} from '../agents/index';
import {
  ResearchChatModule,
  ResearchModule,
  ResearchSourcePortsModule,
  ResearchSpaceCleanup,
  ResearchSpaceCleanupModule,
  WebSourceDeletion,
} from '../research/index';
import {
  SKILL_ADVANCE_JOB_TYPE,
  SkillsChatModule,
  SkillsModule,
  SkillSpaceCleanup,
  SkillSpaceCleanupModule,
} from '../skills/index';
import {
  EmailModule,
  EmailReplyModule,
  EmailRoutingSpaceCleanup,
  EmailRoutingSpaceCleanupModule,
  EmailSourceDeletion,
  EmailSourcePortsModule,
} from '../email/index';
import { FileReadReportCascade, FileReadReportCascadeModule, FilesModule } from '../files/index';
import { NotesModule, NotesSourceDeletion, NotesSourcePortsModule } from '../notes/index';
import { SettingsModule } from '../settings/index';
import {
  PassportCascadeModule,
  PassportExportCascade,
  PassportModule,
  PassportSpaceCleanup,
  PassportSpaceCleanupModule,
  PASSPORT_EXPORT_RETENTION_HOURS,
} from '../passport/index';
import { ModelGatewayModule } from '../model-gateway/index';
import type { LiveModelConfiguration } from '../model-gateway/index';
import { ProvidersModule } from '../providers/index';
import { AttentionModule } from '../attention/index';
import { SourcesModule } from '../sources/index';
import { ImportsModule } from '../imports/index';
import {
  FindingsReportCascade,
  FindingsReportCascadeModule,
  ReportsModule,
  ReportSpaceCleanup,
  ReportSpaceCleanupModule,
} from '../reports/index';
import {
  ProjectAssignmentCascade,
  ProjectAssignmentCascadeModule,
  ProjectsModule,
  ProjectSpaceCleanup,
  ProjectSpaceCleanupModule,
} from '../projects/index';
import {
  MachineBindingModule,
  MachineBindingService,
  SpaceNameModule,
  SpaceNameSource,
  SpacesModule,
} from '../spaces/index';
import { CONNECTOR_HEALTH, OperationsModule } from '../operations/index';
import {
  ConnectorHealthSource,
  ConnectorItemCascade,
  ConnectorItemCascadeModule,
  ConnectorsModule,
  ConnectorSpaceCleanup,
  ConnectorSpaceCleanupModule,
} from '../connectors/index';
import {
  ConfluenceModule,
  ConfluencePageCascade,
  ConfluencePageCascadeModule,
  confluenceConnector,
} from '../confluence/index';
import { COGETO_CONFIG, mailOptions, redactionOptions, researchOptions } from './config';
import type { CogetoConfig } from './config';

/**
 * Composition root of the app process (fast path only: API, dashboard,
 * connectors' HTTP surface, approval endpoints). Declarative wiring only —
 * "initialize everything inline" erosion is the known failure mode
 * (research: project-structure-lessons §1).
 */
export function createAppRootModule(config: CogetoConfig, live: LiveModelConfiguration): unknown {
  // ONE dynamic instance per module, threaded everywhere it is needed (the
  // root's import list AND the registration options of every module that
  // resolves its providers) — the part-4 replacement for globality. Since B13
  // closed, the memory module is the first of these: no provider anywhere
  // resolves through a global domain module.
  const memoryModule = MemoryModule.register({
    qdrantUrl: config.qdrantUrl,
    qdrantApiKey: config.qdrantApiKey,
    embeddingModel: config.modelProviders.tiers.embedding.model,
    // The LIVE object (V2.4 item 7.1): the vector store resolves the active
    // collection from the index state and re-resolves when the configuration
    // version moves, which is how a completed rebuild's switch (committed in
    // the worker) reaches this process within one version poll, no restart.
    modelProviders: config.modelProviders,
    s3: {
      url: config.s3Url,
      publicUrl: config.s3PublicUrl,
      accessKey: config.s3AccessKey,
      secretKey: config.s3SecretKey,
      bucket: config.s3Bucket,
    },
    instanceKeyDir: config.instanceKeyDir,
    // Chat joins notes as a deletable source (r7) — the source-delete
    // endpoint runs the saga for a chat-derived memory too. Each adapter's
    // family module instance is named below.
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
        ConnectorItemCascadeModule,
        ConfluencePageCascadeModule,
        ProjectAssignmentCascadeModule,
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
        // A connector-item row pointing at an erased source has its source
        // reference cleared and reads 'erased' thereafter, so a later sync
        // cannot resurrect the memory (V2.5 item 8.1).
        ConnectorItemCascade,
        // Confluence provenance rows carry titles, the document's own words,
        // so they are ERASED with their source (V2.5 item 8.2).
        ConfluencePageCascade,
        // A project assignment is identifiers only and holds nothing a
        // receipt must promise erased; an assignment naming an erased source
        // is stale state, RELEASED in the same enumeration transaction so
        // deletion takes the source out of its project as one signed act
        // (V2.5 item 8.3).
        ProjectAssignmentCascade,
      ],
    },
    // Delete-vs-ingestion serialization: the saga cancels a source's pending
    // pipeline run inside its enumeration tx.
    ingestionGuard: PipelineIngestionGuard,
    // Eligibility re-pair (V2.3 item 6.1): confirming an uncertain fact
    // enqueues a reconcile repair for it. Ingestion's dependency-free hook,
    // instantiated by the memory module like the guard above.
    eligibilityHook: ReconcileRepairEligibilityHook,
    // Who may read the INSTANCE-WIDE receipt-chain report (V2.0 item 3.7);
    // every other caller gets the verdict over their own receipts.
    adminRole: config.adminRole,
    // Owner erasure's administrative route (issue #632). The app serves it;
    // the worker runs the pass and registers no controller.
    erasureRoute: true,
  });
  // The instance's model and provider configuration (V2.4 item 7.1). One
  // instance, threaded into the root AND into chat, whose answer path asks it
  // which model this user chose for themselves. It imports the memory module
  // instance because the embeddings tier changes through the managed rebuild,
  // whose engine is memory's (item 7.1 second half).
  const providersModule = ProvidersModule.register({
    live,
    masterKey: config.masterKey,
    redacted: config.redactionEnabled,
    reasoningHeadroom: config.modelProviders.reasoningHeadroom,
    timeoutsMs: config.modelProviders.timeoutsMs,
    trustScoresDir: config.trustScoresDir,
    // The app reloads on its own writes, so this poll exists for the changes
    // ANOTHER process made — a second app replica, the worker committing a
    // rebuild's switch, or the operator CLI.
    pollIntervalMs: 30_000,
    controllers: true,
    imports: [memoryModule],
  });
  // Projects as workspaces (V2.5 item 8.3). A leaf domain context: it imports
  // no other domain module, so everything that needs an assignment (chat,
  // files, connectors, research, reports, sources) imports IT with no cycle.
  // It decides nothing about visibility; the gates stay memory's.
  const projectsModule = ProjectsModule.register();
  const retrievalModule = RetrievalModule.register({ imports: [memoryModule] });
  const agentsModule = AgentsModule.register({ imports: [memoryModule] });
  const settingsModule = SettingsModule.register({ imports: [memoryModule] });
  const notesModule = NotesModule.register({ imports: [settingsModule] });
  const filesModule = FilesModule.register({
    fileUpload: {
      uploadMaxBytes: config.uploadMaxBytes,
      downloadUrlTtlSeconds: config.downloadUrlTtlSeconds,
    },
    imports: [memoryModule, settingsModule, projectsModule],
  });
  const emailModule = EmailModule.register({
    mail: mailOptions(config),
    imports: [memoryModule, settingsModule],
  });
  const researchModule = ResearchModule.register({
    research: researchOptions(config),
    skillAdvance: { skillAdvanceJobType: SKILL_ADVANCE_JOB_TYPE },
    imports: [memoryModule, projectsModule],
  });
  const skillsModule = SkillsModule.register({ imports: [memoryModule, researchModule] });
  // One imports instance, threaded to the root AND to reports (V2.3 item
  // 6.2): the report validates an import-scope run id through the service.
  // settingsModule joins so an omitted confirm-time scope falls back to the
  // user's saved default, the same contract as the single-file upload (#490).
  const importsModule = ImportsModule.register({
    imports: [memoryModule, filesModule, settingsModule],
  });
  // The connector platform (V2.5 item 8.1): the owner API and the webhook
  // ingress. No descriptor registers in production yet; the first external
  // The credential store resolves from the global identity seam; the app
  // root deliberately does NOT pass credentialReads, so the decrypting
  // opener is unresolvable in the process that serves requests. The
  // Confluence descriptor (V2.5 item 8.2) is pure: its client is built per
  // worker call from opened secrets, so registering it here adds the KIND
  // without adding any app-side upstream access.
  const connectorsModule = ConnectorsModule.register({
    options: { masterKey: config.masterKey },
    connectors: [confluenceConnector()],
    // A sub-scope can be assigned to a project (V2.5 item 8.3 issue C1), so
    // everything it ingests lands there automatically.
    imports: [projectsModule],
  });
  // The Confluence connect surface (V2.5 item 8.2): validation with the
  // material in hand, then the platform owns everything operational.
  const confluenceModule = ConfluenceModule.register({ imports: [connectorsModule] });
  // The three resolver-binding modules, un-globaled (B15 closed): each is a
  // dynamic instance receiving the modules it composes, and ChatModule
  // receives all three so its options factory resolves the port tokens by
  // identity. The boot assertion below proves the wiring took.
  const emailReplyModule = EmailReplyModule.register({
    imports: [retrievalModule, agentsModule, emailModule],
  });
  const researchChatModule = ResearchChatModule.register({
    imports: [retrievalModule, researchModule],
  });
  const skillsChatModule = SkillsChatModule.register({
    imports: [retrievalModule, researchModule, skillsModule],
  });
  const chatModule = ChatModule.register({
    // filesModule / memoryModule / settingsModule: the conversation-attachment
    // surface (V2.2 item 5.1) delegates upload to files, counts through
    // memory's gated stores, and applies the owner's capture defaults.
    imports: [
      retrievalModule,
      emailReplyModule,
      researchChatModule,
      skillsChatModule,
      filesModule,
      memoryModule,
      settingsModule,
      // The user's own answer-model choice (V2.4 item 7.1).
      providersModule,
      // The retrieval lens (V2.5 item 8.3): a conversation assigned to a
      // project answers from that project's sources by default. A FILTER,
      // resolved here and handed to retrieval as a value; never a gate.
      projectsModule,
    ],
  });
  @Module({
    imports: [
      DatabaseModule.register({ databaseUrl: config.databaseUrl, poolMax: config.pgPoolMax }),
      // Abuse/DoS limits — global, so the rate-limit guard, ingest
      // quota, SSE caps and model budget are injectable across controllers.
      LimitsModule.register(config.limits, config.timezone),
      // Per-user context + language. No longer global (boundary contract §4):
      // imported here for this root's own AttentionService, and separately by
      // every module whose providers inject it.
      UserContextModule,
      IdentityModule.register({
        internalBaseUrl: config.oidc.internalUrl,
        externalDomain: config.oidc.externalDomain,
        // small TTL bounds the token-revocation window (see the seam
        // README +).: validate JWT iss/aud locally.
        cacheTtlSeconds: 10,
        issuer: config.oidc.issuer,
        expectedAudience: readOidcClientId(config.webConfigFile),
        adminRole: config.adminRole,
        // Connector credentials seal under the instance master key (V2.5
        // item 8.1). No credentialReads here: the app can store, describe
        // and destroy credentials but never open one.
        masterKey: config.masterKey,
        // The login bootstrap, GET /api/config + POST /api/config/demo-login.
        // App-only: the worker authenticates nothing over HTTP.
        webConfig: {
          webConfigFile: config.webConfigFile,
          demoSessionFile: config.demoSessionFile,
          production: config.production,
          demoMode: config.demoMode,
        },
        // Machine callers' per-credential space bindings (section 6c): the
        // spaces module implements the lookup; unbound machines are refused.
        machineBindings: { imports: [MachineBindingModule], adapter: MachineBindingService },
      }),
      ModelGatewayModule.register({
        providers: config.modelProviders,
        // The gateway follows the live configuration (V2.4 item 7.1): a saved
        // assignment reaches the next call rather than the next restart.
        live,
        redaction: redactionOptions(config),
        // Enforce the per-user daily model budget on the app's user-attributed
        // calls; the worker registers this without budget.
        budget: true,
        // GET /api/settings/model-config displays the gateway's own resolved
        // configuration, so the seam serves it; app-only (the worker has no HTTP).
        modelConfig: {
          modelProviders: config.modelProviders,
          redactionEnabled: config.redactionEnabled,
        },
      }),
      providersModule,
      memoryModule,
      retrievalModule,
      chatModule,
      notesModule,
      settingsModule,
      ChatSourceModule, // the chat source-deletion adapter for the delete endpoint
      // verification + dreaming read endpoints; the memory instance for the
      // dreaming digest's gated reads (B13).
      IngestionModule.forQueries({ imports: [memoryModule] }),
      agentsModule,
      filesModule,
      emailModule,
      researchModule,
      skillsModule,
      skillsChatModule,
      // Reply drafting + the chat → reply resolver (O4) — app-only (needs
      // RetrievalService + ApprovalService); the worker never drafts.
      emailReplyModule,
      // The research gate + chat → research resolver + synthesis (
      // Part B) — app-only for the same reason; the worker never researches.
      researchChatModule,
      // The Memory Passport (spec §11.4): export trigger/status/download.
      // Assembly is a worker job; the app only creates requests and serves reads.
      PassportModule.register({
        instanceKeyDir: config.instanceKeyDir,
        downloadUrlTtlSeconds: config.downloadUrlTtlSeconds,
        exportRetentionHours: PASSPORT_EXPORT_RETENTION_HOURS,
        imports: [memoryModule, SpaceNameModule],
        // The per-space manifest names the space it exports.
        spaceNames: SpaceNameSource,
      }),
      // The "what needs my attention" feed + the dashboard statistics. Its own
      // context (V2.0 item 3.6 part 2): the surface composes memory, retrieval,
      // agents and ingestion, and owns the read-state pair behind it.
      AttentionModule.register({
        imports: [memoryModule, retrievalModule, agentsModule],
      }),
      // The Sources surface's read context (V2.2 item 5.2): the catalog and
      // the per-source inspection. Owns no tables; every read goes through the
      // owning modules' public interfaces.
      SourcesModule.register({
        imports: [
          memoryModule,
          filesModule,
          notesModule,
          emailModule,
          researchModule,
          chatModule,
          connectorsModule,
          confluenceModule,
          // Filter the catalog by project, and carry each row's project
          // (V2.5 item 8.3 issue C3).
          projectsModule,
        ],
      }),
      // Bulk import (V2.2 item 5.3): manifest + confirm + record surface.
      importsModule,
      // Projects as workspaces (V2.5 item 8.3): the folder surface.
      projectsModule,
      // Spaces (docs/features/spaces.md): the sealed-partition records, the
      // data-and-API surface, and space deletion (session 2): the plan and
      // request endpoints live here; the erasure pass runs in the worker.
      SpacesModule.register({
        imports: [memoryModule],
        cleanups: {
          imports: [
            ProjectSpaceCleanupModule,
            EntityAliasSpaceCleanupModule,
            ExtractionGateSpaceCleanupModule,
            ImportSpaceCleanupModule,
            ResearchSpaceCleanupModule,
            SkillSpaceCleanupModule,
            ReportSpaceCleanupModule,
            PassportSpaceCleanupModule,
            ConnectorSpaceCleanupModule,
            EmailRoutingSpaceCleanupModule,
            AgentsSpaceCleanupModule,
          ],
          adapters: [
            ProjectSpaceCleanup,
            EntityAliasSpaceCleanup,
            ExtractionGateSpaceCleanup,
            ImportSpaceCleanup,
            ResearchSpaceCleanup,
            SkillSpaceCleanup,
            ReportSpaceCleanup,
            PassportSpaceCleanup,
            ConnectorSpaceCleanup,
            EmailRoutingSpaceCleanup,
            AgentsSpaceCleanup,
          ],
        },
      }),
      // The connector platform (V2.5 item 8.1): owner API + webhook ingress.
      connectorsModule,
      // The first real connector (V2.5 item 8.2).
      confluenceModule,
      // The findings report (V2.3 item 6.2): trigger/status/download only.
      // Generation, signing and retention are the worker's.
      ReportsModule.register({
        downloadUrlTtlSeconds: config.downloadUrlTtlSeconds,
        // A report can be generated FOR a project (V2.5 item 8.3 issue C2):
        // the scope is validated here and enumerated in the worker.
        imports: [memoryModule, importsModule, projectsModule],
      }),
      // The instance's own operational surface: /api/health and the capability
      // registry, /api/jobs, /api/audit. It owns no tables; every read goes
      // through the owning module's public interface.
      OperationsModule.register({
        imports: [memoryModule, connectorsModule],
        // The connector fleet's capability entry (V2.5 item 8.1, issue A4):
        // operations declares the port, the platform implements it, this
        // binding is what makes the entry exist.
        connectorHealth: { provide: CONNECTOR_HEALTH, useExisting: ConnectorHealthSource },
        qdrantUrl: config.qdrantUrl,
        s3Url: config.s3Url,
        mailSmtpAddress: config.mailSmtpAddress,
        adminRole: config.adminRole,
        production: config.production,
        demoMode: config.demoMode,
        consolesEnabled: config.consolesEnabled,
        redactionEnabled: config.redactionEnabled,
        redactionUrl: config.redactionUrl,
        researchEnabled: config.researchEnabled,
        searxngUrl: config.searxngUrl,
        mailEnabled: config.mailEnabled,
        composeProfiles: config.composeProfiles,
        jobsOverdueHours: config.jobsOverdueHours,
        modelProviders: config.modelProviders,
        // The same vision-probe deadline the reading ladder uses, so the panel
        // and the reader cannot disagree about whether vision works.
        visionProbeTimeoutMs: config.limits.parse.visionProbeTimeoutMs,
        reasoningProbeTimeoutMs: config.reasoningProbeTimeoutMs,
      }),
    ],
    providers: [
      { provide: COGETO_CONFIG, useValue: config },
      // Boot assertion (V2.0 item 3.6 part 4): the served chat surface must
      // have EVERY seam wired — reply drafting, research, skills, user
      // context. An absent seam degrades chat silently by design in bare
      // harnesses, so the root that serves real traffic verifies presence at
      // startup; Nest instantiates providers eagerly, so a miswire fails the
      // boot, not the first unlucky user turn.
      {
        provide: 'CHAT_WIRING_BOOT_ASSERTION',
        useFactory: (chat: ChatService) => {
          chat.assertFullyWired();
          return true;
        },
        inject: [ChatService],
      },
      // Default-deny auth: the bearer guard runs on EVERY route; only
      // routes marked @Public (health/config/instance) opt out. A new
      // controller that forgets @UseGuards is closed, not silently open.
      { provide: APP_GUARD, useExisting: BearerAuthGuard },
      // Map a spent daily model budget to HTTP 429 for non-stream endpoints
      //; the chat SSE path surfaces it as a distinct error event instead.
      { provide: APP_FILTER, useClass: ModelBudgetExceptionFilter },
    ],
  })
  class AppRootModule {}

  return AppRootModule;
}

/**
 * The SPA client id (aud validation) from the zitadel-init-written web
 * config file. Best-effort at boot: absent/malformed → undefined, and the aud
 * check is skipped (opaque tokens skip it anyway).
 */
function readOidcClientId(webConfigFile: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(webConfigFile, 'utf8')) as { clientId?: unknown };
    return typeof parsed.clientId === 'string' && parsed.clientId ? parsed.clientId : undefined;
  } catch {
    return undefined;
  }
}
