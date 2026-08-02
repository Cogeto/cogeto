import { readFileSync } from 'node:fs';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { DatabaseModule, LimitsModule, UserContextModule } from '../infrastructure/index';
import { BearerAuthGuard, IdentityModule } from '../identity/index';
import { ModelBudgetExceptionFilter } from './model-budget.filter';
import {
  IngestionModule,
  PipelineIngestionGuard,
  SuppressedFactCascade,
  SuppressedFactCascadeModule,
} from '../ingestion/index';
import { MemoryModule } from '../memory/index';
import {
  ChatAnswerCascade,
  ChatService,
  ChatSourceDeletion,
  ChatSourceModule,
  ConversationSourceDeletion,
  RetrievalModule,
} from '../retrieval/index';
import { AgentsModule, ReplyDraftCascade, ReplyDraftCascadeModule } from '../agents/index';
import {
  ConnectorsModule,
  EmailReplyModule,
  EmailSourceDeletion,
  NotesSourceDeletion,
  ResearchChatModule,
  SkillsModule,
  WebSourceDeletion,
} from '../connectors/index';
import {
  PassportCascadeModule,
  PassportExportCascade,
  PassportModule,
  PASSPORT_EXPORT_RETENTION_HOURS,
} from '../passport/index';
import { ModelGatewayModule } from '../model-gateway/index';
import { AttentionModule } from '../attention/index';
import { OperationsModule } from '../operations/index';
import { COGETO_CONFIG, mailOptions, redactionOptions, researchOptions } from './config';
import type { CogetoConfig } from './config';

/**
 * Composition root of the app process (fast path only: API, dashboard,
 * connectors' HTTP surface, approval endpoints). Declarative wiring only —
 * "initialize everything inline" erosion is the known failure mode
 * (research: project-structure-lessons §1).
 */
export function createAppRootModule(config: CogetoConfig): unknown {
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
        // The login bootstrap, GET /api/config + POST /api/config/demo-login.
        // App-only: the worker authenticates nothing over HTTP.
        webConfig: {
          webConfigFile: config.webConfigFile,
          demoSessionFile: config.demoSessionFile,
          production: config.production,
          demoMode: config.demoMode,
        },
      }),
      ModelGatewayModule.register({
        providers: config.modelProviders,
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
        // Chat joins notes as a deletable source (r7) — the
        // source-delete endpoint runs the saga for a chat-derived memory too.
        sourceDeletions: {
          // ChatSourceModule provides the two chat adapters below; explicit
          // since it stopped being global (boundary contract §4). The connector
          // adapters still resolve from the global ConnectorsModule (B14).
          imports: [ChatSourceModule],
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
      RetrievalModule,
      ChatSourceModule, // the chat source-deletion adapter for the delete endpoint
      IngestionModule.forQueries(), // verification + dreaming read endpoints
      AgentsModule,
      ConnectorsModule.register({
        fileUpload: {
          uploadMaxBytes: config.uploadMaxBytes,
          downloadUrlTtlSeconds: config.downloadUrlTtlSeconds,
        },
        mail: mailOptions(config),
        research: researchOptions(config),
      }),
      // Reply drafting + the chat → reply resolver (O4) — app-only (needs
      // RetrievalService + ApprovalService); the worker never drafts. Global, so
      // ChatService resolves CHAT_REPLY_RESOLVER.
      EmailReplyModule,
      // The research gate + chat → research resolver + synthesis (
      // Part B) — app-only for the same reason; the worker never researches.
      ResearchChatModule,
      // Named skills: the planner + run surface +
      // chat → skill resolver — app-only (planning needs retrieval); the
      // engine's execution reaches the worker as the skill.advance job.
      SkillsModule,
      // The Memory Passport (spec §11.4): export trigger/status/download.
      // Assembly is a worker job; the app only creates requests and serves reads.
      PassportModule.register({
        instanceKeyDir: config.instanceKeyDir,
        downloadUrlTtlSeconds: config.downloadUrlTtlSeconds,
        exportRetentionHours: PASSPORT_EXPORT_RETENTION_HOURS,
      }),
      // The "what needs my attention" feed + the dashboard statistics. Its own
      // context (V2.0 item 3.6 part 2): the surface composes memory, retrieval,
      // agents and ingestion, and owns the read-state pair behind it.
      AttentionModule,
      // The instance's own operational surface: /api/health and the capability
      // registry, /api/jobs, /api/audit. It owns no tables; every read goes
      // through the owning module's public interface.
      OperationsModule.register({
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
