import { readFileSync } from 'node:fs';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { DatabaseModule, LimitsModule, UserContextModule } from '../infrastructure/index';
import { BearerAuthGuard, IdentityModule } from '../identity/index';
import { ModelBudgetExceptionFilter } from './model-budget.filter';
import { IngestionModule, PipelineIngestionGuard } from '../ingestion/index';
import { MemoryModule } from '../memory/index';
import {
  ChatAnswerCascade,
  ChatSourceDeletion,
  ChatSourceModule,
  RetrievalModule,
} from '../retrieval/index';
import { AgentsModule, ReplyDraftCascade, ReplyDraftCascadeModule } from '../agents/index';
import {
  ConnectorsModule,
  EmailReplyModule,
  EmailSourceDeletion,
  NotesSourceDeletion,
  ResearchChatModule,
  WebSourceDeletion,
} from '../connectors/index';
import {
  TaskConclusionSourceDeletion,
  TaskConclusionSourceModule,
  TasksCascade,
  TasksModule,
} from '../tasks/index';
import { PassportModule, PASSPORT_EXPORT_RETENTION_HOURS } from '../passport/index';
import { ModelGatewayModule } from '../model-gateway/index';
import { COGETO_CONFIG, mailOptions, redactionOptions, researchOptions } from './config';
import type { CogetoConfig } from './config';
import { AttentionController, DashboardController } from './attention.controller';
import { AttentionService } from './attention.service';
import { CapabilitiesService } from './capabilities';
import { AuditController } from './audit.controller';
import { HealthController } from './health.controller';
import { InstanceController } from './instance.controller';
import { JobsController } from './jobs.controller';
import { WebConfigController } from './web-config.controller';
import { ModelConfigController } from './model-config.controller';

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
      // Abuse/DoS limits (FIX-2) — global, so the rate-limit guard, ingest
      // quota, SSE caps and model budget are injectable across controllers.
      LimitsModule.register(config.limits, config.timezone),
      // Per-user context + language (P6.6) — global, same rationale.
      UserContextModule,
      IdentityModule.register({
        internalBaseUrl: config.oidc.internalUrl,
        externalDomain: config.oidc.externalDomain,
        // QS-11: small TTL bounds the token-revocation window (see the seam
        // README + decision 0026). QS-17: validate JWT iss/aud locally.
        cacheTtlSeconds: 10,
        issuer: config.oidc.issuer,
        expectedAudience: readOidcClientId(config.webConfigFile),
        adminRole: config.adminRole,
      }),
      ModelGatewayModule.register({
        providers: config.modelProviders,
        redaction: redactionOptions(config),
        // Enforce the per-user daily model budget on the app's user-attributed
        // calls (QS-2); the worker registers this without budget.
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
        // Chat joins notes as a deletable source (decision 0021 r7) — the
        // source-delete endpoint runs the saga for a chat-derived memory too.
        sourceDeletions: {
          adapters: [
            NotesSourceDeletion,
            ChatSourceDeletion,
            EmailSourceDeletion,
            // Conclusion rows are deletable sources too (decision 0037).
            TaskConclusionSourceDeletion,
            // Web pages are deletable sources (Priority 5 Part A, 0043).
            WebSourceDeletion,
          ],
        },
        derivedCascades: {
          imports: [TasksModule.forApi(), ChatSourceModule, ReplyDraftCascadeModule],
          // Tasks are deleted with their memories; assistant answers citing
          // erased memories are redacted (QS-7, decision 0025).
          adapters: [TasksCascade, ChatAnswerCascade, ReplyDraftCascade],
        },
        // Delete-vs-ingestion serialization (QS-5, decision 0024): the saga
        // cancels a source's pending pipeline run inside its enumeration tx.
        ingestionGuard: PipelineIngestionGuard,
      }),
      RetrievalModule,
      ChatSourceModule, // the chat source-deletion adapter for the delete endpoint
      TaskConclusionSourceModule, // ditto for task conclusions (decision 0037)
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
      TasksModule.forApi(),
      // The digest's TASKS section as a global provider, so ingestion's digest
      // endpoint can inject it without importing tasks (O2-A; F3 handoff §3).
      TasksModule.forDigest(),
      // Reply drafting + the chat → reply resolver (O4) — app-only (needs
      // RetrievalService + ApprovalService); the worker never drafts. Global, so
      // ChatService resolves CHAT_REPLY_RESOLVER.
      EmailReplyModule,
      // The research gate + chat → research resolver + synthesis (Priority 5
      // Part B) — app-only for the same reason; the worker never researches.
      ResearchChatModule,
      // The Memory Passport (§B.5, decision 0029): export trigger/status/download.
      // Assembly is a worker job; the app only creates requests and serves reads.
      PassportModule.register({
        instanceKeyDir: config.instanceKeyDir,
        downloadUrlTtlSeconds: config.downloadUrlTtlSeconds,
        exportRetentionHours: PASSPORT_EXPORT_RETENTION_HOURS,
      }),
    ],
    controllers: [
      AttentionController,
      DashboardController,
      AuditController,
      HealthController,
      InstanceController,
      JobsController,
      WebConfigController,
      ModelConfigController,
    ],
    providers: [
      { provide: COGETO_CONFIG, useValue: config },
      // The attention/stats aggregator composes memory, tasks, agents and the
      // dreaming digest through their public interfaces (Post-v1 Priority 2).
      AttentionService,
      // The capability registry (P6.7, decision 0055): /api/health's
      // capability/job summaries and the boot banner read one snapshot.
      CapabilitiesService,
      // Default-deny auth (QS-18): the bearer guard runs on EVERY route; only
      // routes marked @Public() (health/config/instance) opt out. A new
      // controller that forgets @UseGuards is closed, not silently open.
      { provide: APP_GUARD, useExisting: BearerAuthGuard },
      // Map a spent daily model budget to HTTP 429 for non-stream endpoints
      // (QS-2); the chat SSE path surfaces it as a distinct error event instead.
      { provide: APP_FILTER, useClass: ModelBudgetExceptionFilter },
    ],
  })
  class AppRootModule {}

  return AppRootModule;
}

/**
 * The SPA client id (QS-17 aud validation) from the zitadel-init-written web
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
