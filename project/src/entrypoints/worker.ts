import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { run } from 'graphile-worker';
import type { Runner } from 'graphile-worker';
import { loadConfig, redactionOptions } from './config';
import { createLogger, PinoNestLogger } from './logger';
import { createWorkerRootModule } from './worker-root.module';
import {
  createDb,
  describeErrorLine,
  ensureInstanceKeys,
  releaseAbandonedJobLocks,
} from '../infrastructure/index';
import { logRedactionState } from './redaction-boot';
import {
  assertEmbeddingSpaceConsistent,
  installModelConfiguration,
  logModelConfiguration,
} from './model-boot';
import {
  ACTIVE_PROMPTS,
  DREAM_CRONTAB,
  DreamingService,
  EXTRACTION_REFUSAL_RETENTION_CRONTAB,
  ExtractionGateStore,
  IngestionPipeline,
  ReconcileRepair,
} from '../ingestion/index';
import {
  DeletionExecutor,
  EmbeddingRebuildService,
  IntegritySweep,
  MemoryObjectStore,
  MemoryStore,
  resumeEmbeddingRebuildOnBoot,
  SWEEP_CRONTAB,
} from '../memory/index';
import { APPROVAL_EXPIRY_CRONTAB, ApprovalExecutor, ApprovalService } from '../agents/index';
import { PassportExportExecutor, PASSPORT_RETENTION_CRONTAB } from '../passport/index';
import { ReportExportExecutor, REPORT_RETENTION_CRONTAB } from '../reports/index';
import { CONTEXT_SUGGEST_PROMPT } from '../settings/index';
import { EmailAllowlistService, EMAIL_REFUSAL_RETENTION_CRONTAB } from '../email/index';
import { ResearchConclusionService, ResearchSynthesisService } from '../research/index';
import { SKILL_BRIEF_PROMPT, SKILL_PLAN_PROMPT, SkillEngine } from '../skills/index';
import { QUERY_REWRITE_PROMPT } from '../retrieval/index';
import { ImportCoordinator } from '../imports/index';
import {
  CONNECTOR_MAINTENANCE_CRONTAB,
  ConnectorMaintenance,
  ConnectorPresenceSweep,
  ConnectorSyncEngine,
  ConnectorWebhookProcessor,
} from '../connectors/index';
import { ConfluenceEstimateService } from '../confluence/index';
import {
  ANSWER_PROMPT,
  ChatAttachmentReadService,
  CONVERSATION_TITLE_PROMPT,
  ConversationTitler,
} from '../chat/index';
import {
  assertLocalRuntimeReady,
  createModelGateway,
  loadPrompt,
  ModelGateway,
  probeReasoning,
  recordPromptVersion,
} from '../model-gateway/index';
import { ProviderConfigService } from '../providers/index';
import { MODEL_EGRESS_AUDIT, MODEL_USAGE_METER } from '../infrastructure/index';
import type { ModelEgressAudit, ModelUsageMeter } from '../infrastructure/index';
import { attributedTask, buildTaskList } from './worker-tasks';
import {
  credentialsBanner,
  DEMO_RESET_JOB_TYPE,
  DemoResetInProgressError,
  ensureDemoCredentials,
  establishDemoSession,
  resetDemoWorld,
} from './demo/index';

const HEARTBEAT_FILE = '/tmp/worker-heartbeat';
const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * worker — the slow-path process (spec §15): Graphile Worker runner over the
 * Postgres queue (spec §15.4) plus the Nest application context for module services.
 * No HTTP. Assumes migrations already ran (init container).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  logRedactionState(logger, config); //: state the effective posture loudly.
  // The DATABASE's model configuration, in force before anything is built
  // (V2.4 item 7.1). The worker seeds too: whichever process starts first
  // wins the atomic claim, and the other finds the seeding already done.
  const live = await installModelConfiguration(config, logger);
  logModelConfiguration(logger, config); // State the active configuration id.
  // Embedding-space guard: a changed embeddings
  // model refuses boot until reindex has re-embedded the stored vectors.
  await assertEmbeddingSpaceConsistent(config);
  // Local-runtime probe: an unreachable Ollama
  // runtime or a never-pulled model refuses boot, never fails at first request.
  await assertLocalRuntimeReady(config.modelProviders);

  const context = await NestFactory.createApplicationContext(
    createWorkerRootModule(config, live) as never,
    { logger: new PinoNestLogger(logger) },
  );
  context.enableShutdownHooks();

  // Reasoning warmup (Part B of reasoning support): learn at boot whether the
  // generation bindings return a separate reasoning field, so the FIRST capped
  // call this process makes — above all the reading ladder's vision probe —
  // already gets its maxTokens headroom instead of failing empty. Never
  // refuses boot: a failed probe leaves headroom off, and the adapter still
  // learns from the first real response that carries the field.
  try {
    const probe = await probeReasoning(context.get(ModelGateway), config.modelProviders, {
      timeoutMs: config.reasoningProbeTimeoutMs,
    });
    logger.info(
      `reasoning ${probe.reasoning ? 'ON' : 'OFF'}${probe.detail ? ` (${probe.detail})` : ''}`,
    );
  } catch (error) {
    logger.warn(
      `reasoning warmup probe failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // explicit pool ceiling. This pool backs BOTH the graphile runner and
  // the job handlers' idempotency transactions (which the pipeline holds open
  // across model calls), so it must clear worker concurrency (2) with headroom
  // for the single-flight locks and graphile's own connections.
  const pool = new Pool({ connectionString: config.databaseUrl, max: config.pgPoolMax });
  // graphile-worker 0.17 no longer installs a default pool error handler (it
  // warns on bare pools): an unhandled idle-client error would crash the
  // process. Log it; the runner's own retry/backoff handles the reconnect.
  pool.on('error', (error) => {
    logger.error({ err: error }, 'pg pool idle client error');
  });
  const db = createDb(pool);

  // Register the active prompt versions (spec §12.3) — also the immutability check
  // a released version whose file hash changed fails the boot.
  for (const ref of [
    ...ACTIVE_PROMPTS,
    ANSWER_PROMPT,
    QUERY_REWRITE_PROMPT,
    CONTEXT_SUGGEST_PROMPT,
    CONVERSATION_TITLE_PROMPT,
    SKILL_PLAN_PROMPT,
    SKILL_BRIEF_PROMPT,
  ]) {
    const prompt = await loadPrompt(ref.family, ref.version);
    await recordPromptVersion(db, prompt);
    logger.info(
      { family: prompt.family, version: prompt.version, sha256: prompt.contentHash.slice(0, 12) },
      'prompt version registered',
    );
  }

  // Idempotent Qdrant collection + payload-index creation (spec §4.2).
  await context.get(MemoryStore).ensureIndexReady();
  logger.info('memory vector collection ready');

  // Receipt signing needs the instance keypair (spec §11.1). Compose: generated by
  // the migrate init job, mounted read-only here — this is then a no-op check.
  // Bare local runs (no init job) generate into the gitignored default dir.
  try {
    await ensureInstanceKeys(config.instanceKeyDir);
  } catch (error) {
    logger.warn(
      { err: error, dir: config.instanceKeyDir },
      'could not ensure instance keys (read-only mount without keys?), signing will fail until the migrate job runs',
    );
  }

  const pipeline = context.get(IngestionPipeline);
  const objects = context.get(MemoryObjectStore);
  const gateway = context.get(ModelGateway);

  // The managed embedding rebuild (V2.4 item 7.1 second half): the marriage
  // of memory's engine and providers' assignment flip happens HERE, the one
  // place allowed to know both sides. The target-bound gateway goes through
  // the ordinary factory, so the budget meter, the egress audit and redaction
  // wrap the corpus's embedding calls exactly like every other model call.
  const providerConfig = context.get(ProviderConfigService);
  const usageMeter = context.get<ModelUsageMeter>(MODEL_USAGE_METER, { strict: false });
  const egressAudit = context.get<ModelEgressAudit>(MODEL_EGRESS_AUDIT, { strict: false });
  const embeddingRebuildPass = (): ReturnType<EmbeddingRebuildService['runPass']> =>
    context.get(EmbeddingRebuildService).runPass({
      gatewayFor: async (target) =>
        createModelGateway({
          providers: await providerConfig.embeddingRunProvidersFor(target.providerId, target.model),
          // Redaction wraps the rebuild too: re-embedding under redaction must
          // re-embed pseudonymized text, matching how vectors are always made.
          redaction: redactionOptions(config),
          usageMeter,
          egressAudit,
        }),
      switchPort: providerConfig.embeddingsSwitchPort(),
      log: (message) => logger.info({}, `embedding rebuild: ${message}`),
    });

  const taskList = buildTaskList(db, {
    pipeline,
    memoryStore: context.get(MemoryStore),
    deletionExecutor: context.get(DeletionExecutor),
    integritySweep: context.get(IntegritySweep),
    dreaming: context.get(DreamingService),
    reconcileRepair: context.get(ReconcileRepair),
    approvalService: context.get(ApprovalService),
    approvalExecutor: context.get(ApprovalExecutor),
    passportExecutor: context.get(PassportExportExecutor),
    reportExecutor: context.get(ReportExportExecutor),
    allowlist: context.get(EmailAllowlistService),
    extractionGate: context.get(ExtractionGateStore),
    conversationTitler: context.get(ConversationTitler),
    attachmentReader: context.get(ChatAttachmentReadService),
    importCoordinator: context.get(ImportCoordinator),
    connectorSyncEngine: context.get(ConnectorSyncEngine),
    connectorWebhookProcessor: context.get(ConnectorWebhookProcessor),
    connectorMaintenance: context.get(ConnectorMaintenance),
    connectorPresenceSweep: context.get(ConnectorPresenceSweep),
    confluenceEstimate: context.get(ConfluenceEstimateService),
    researchConcluder: context.get(ResearchConclusionService),
    researchSynthesis: context.get(ResearchSynthesisService),
    skillEngine: context.get(SkillEngine),
    objects,
    gateway,
    embeddingRebuildPass,
    log: (event, message) => logger.info(event, message),
  });

  // Ana sandbox: the scheduled reset is registered +
  // scheduled ONLY on a demo instance — never on a customer instance. It reuses
  // the demo Principal from the seed job and runs the same wipe-and-reseed
  // routine. One more crontab LINE (demoLine), never a second scheduler.
  let demoLine = '';
  if (config.demoMode) {
    taskList[DEMO_RESET_JOB_TYPE] = attributedTask(DEMO_RESET_JOB_TYPE, async () => {
      const { api, ownerId } = await establishDemoSession(config);
      try {
        await resetDemoWorld({
          pool,
          db,
          api,
          ownerId,
          objects,
          gateway,
          qdrantUrl: config.qdrantUrl,
          qdrantApiKey: config.qdrantApiKey,
          embeddingModel: config.modelProviders.tiers.embedding.model,
          strict: false, // a failed scheduled reset logs; the next one repairs it
          excludeTask: DEMO_RESET_JOB_TYPE, // don't count our own running job
          log: (message) => logger.info({}, message),
        });
        // A reset rotates the sandbox login password; surface it.
        const creds = await ensureDemoCredentials(config.demoSessionFile, { rotate: true });
        logger.info({}, credentialsBanner(creds));
        logger.info({}, 'scheduled demo reset completed');
      } catch (error) {
        // another reset already holds the lock — skip cleanly, don't fail
        // the job (which would retry into the running reset).
        if (error instanceof DemoResetInProgressError) {
          logger.info({}, 'scheduled demo reset skipped, another reset in progress');
          return;
        }
        throw error;
      }
    });
    demoLine = `\n${config.demoResetCron} ${DEMO_RESET_JOB_TYPE}`;
    logger.info({ cron: config.demoResetCron }, 'demo mode: scheduled reset enabled');
  }

  // Locks a dead worker left behind are released before this one starts
  // (issue #496): graphile would otherwise hold them for four hours, and a
  // rebuild or restart mid-job then shows one-processing-forever. One worker
  // per instance is the compose contract, so at boot every held lock is a
  // dead process's.
  try {
    const released = await releaseAbandonedJobLocks(db);
    if (released > 0) logger.info({ released }, 'released job locks abandoned by a dead worker');
  } catch (error) {
    logger.warn({ err: error }, 'abandoned-lock release failed');
  }

  // A rebuild that lost its advance job with a dead worker resumes here:
  // duplicates are harmless (single-flight), and a boot with no live rebuild
  // is a no-op.
  try {
    await resumeEmbeddingRebuildOnBoot(db);
  } catch (error) {
    logger.warn({ err: error }, 'embedding rebuild boot resume check failed');
  }

  const runner: Runner = await run({
    pgPool: pool,
    concurrency: 2,
    taskList,
    // Nightly schedule (graphile cron): the 03:00 integrity sweep (spec §11.1 step 4)
    // and the 03:30 dreaming cycle, plus the
    // every-5-minute approval expiry pass, plus the demo reset on a
    // demo instance. On-demand sweep/dream go through their entrypoints instead.
    //
    // graphile cron honours the process timezone, so the worker container
    // pins TZ=UTC (compose) — these times are UTC and DST never shifts them. A
    // DST transition can still make a wall-clock hour repeat/skip on non-UTC
    // hosts; the single-flight advisory lock on each recurring job (worker-tasks)
    // makes a double-fire a clean skip, and the jobs are idempotent by design.
    crontab: `${SWEEP_CRONTAB}\n${DREAM_CRONTAB}\n${APPROVAL_EXPIRY_CRONTAB}\n${PASSPORT_RETENTION_CRONTAB}\n${REPORT_RETENTION_CRONTAB}\n${EMAIL_REFUSAL_RETENTION_CRONTAB}\n${EXTRACTION_REFUSAL_RETENTION_CRONTAB}\n${CONNECTOR_MAINTENANCE_CRONTAB}${demoLine}`,
    noHandleSignals: true,
  });
  logger.info('cogeto worker started (graphile runner + task registry)');

  const heartbeat = setInterval(() => {
    void writeFile(HEARTBEAT_FILE, new Date().toISOString()).catch((error: unknown) => {
      logger.warn({ err: error }, 'heartbeat write failed');
    });
  }, HEARTBEAT_INTERVAL_MS);
  await writeFile(HEARTBEAT_FILE, new Date().toISOString());

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    await runner.stop();
    await pool.end();
    await context.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

// Top-level handlers log the error class + a scrubbed, bounded message only —
// never the raw error (stack / `received …` can carry secrets or model output),
//.
process.on('unhandledRejection', (reason: unknown) => {
  console.error(`unhandledRejection: ${describeErrorLine(reason)}`);
});
process.on('uncaughtException', (error: unknown) => {
  console.error(`uncaughtException: ${describeErrorLine(error)}`);
  process.exit(1);
});

main().catch((error: unknown) => {
  console.error(`worker failed to start: ${describeErrorLine(error)}`);
  process.exit(1);
});
