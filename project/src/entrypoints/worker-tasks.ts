import type { Task, TaskList } from 'graphile-worker';
import type { SourceTypeKey } from '@cogeto/shared';
import {
  idempotentTask,
  JOB_PRINCIPAL_KEY,
  runSingleFlight,
  runWithUsageContext,
  setUsageTaskFamily,
  setUsageUser,
  writeAudit,
} from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import {
  DREAM_JOB_TYPE,
  EXTRACTION_REFUSAL_RETENTION_JOB_TYPE,
  FILE_DISCARD_CLEANUP_JOB_TYPE,
  INGESTION_PIPELINE_JOB_TYPE,
} from '../ingestion/index';
import type {
  DreamingService,
  ExtractionGateStore,
  IngestionPipeline,
  PipelineLog,
} from '../ingestion/index';
import {
  DELETION_JOB_TYPE,
  MEMORY_EMBED_JOB_TYPE,
  runMemoryEmbedJob,
  SWEEP_JOB_TYPE,
} from '../memory/index';
import type {
  DeletionExecutor,
  IntegritySweep,
  MemoryObjectStore,
  MemoryStore,
} from '../memory/index';
import { APPROVAL_EXECUTE_JOB_TYPE, APPROVAL_EXPIRY_JOB_TYPE } from '../agents/index';
import type { ApprovalExecutor, ApprovalService } from '../agents/index';
import { PASSPORT_EXPORT_JOB_TYPE, PASSPORT_RETENTION_JOB_TYPE } from '../passport/index';
import type { PassportExportExecutor } from '../passport/index';
import { EMAIL_REFUSAL_RETENTION_JOB_TYPE } from '../email/index';
import type { EmailAllowlistService } from '../email/index';
import { SKILL_ADVANCE_JOB_TYPE } from '../skills/index';
import { RESEARCH_CONCLUDE_JOB_TYPE } from '../research/index';
import type { ResearchConclusionService, ResearchSynthesisService } from '../research/index';
import type { SkillEngine } from '../skills/index';
import { CHAT_ATTACHMENT_READ_JOB_TYPE, CONVERSATION_TITLE_JOB_TYPE } from '../chat/index';
import type { ChatAttachmentReadService, ConversationTitler } from '../chat/index';
import type { ModelGateway } from '../model-gateway/index';

export interface WorkerTaskDeps {
  pipeline: IngestionPipeline;
  memoryStore: MemoryStore;
  deletionExecutor: DeletionExecutor;
  integritySweep: IntegritySweep;
  dreaming: DreamingService;
  approvalService: ApprovalService;
  approvalExecutor: ApprovalExecutor;
  passportExecutor: PassportExportExecutor;
  allowlist: EmailAllowlistService;
  extractionGate: ExtractionGateStore;
  conversationTitler: ConversationTitler;
  attachmentReader: ChatAttachmentReadService;
  researchConcluder: ResearchConclusionService;
  researchSynthesis: ResearchSynthesisService;
  skillEngine: SkillEngine;
  objects: MemoryObjectStore;
  gateway: ModelGateway;
  /** Bound to pino by the worker entrypoint. Counts only — never content. */
  log: PipelineLog;
}

/**
 * The worker's task registry (composition root — modules contribute tasks as
 * their slices ship). `echo` is the spec §15.4 round-trip demo: its observable effect
 * is one audit row, written in the idempotency transaction, so a duplicate
 * delivery provably changes nothing.
 */
/**
 * Opens the worker's usage scope around a task (security audit 2.0 SEC-10).
 *
 * Worker model traffic used to be entirely unmetered: this process registered
 * the gateway without the budget decorator, and the decorator no-ops with no
 * user in scope. So a user could enqueue work up to the ingest quota and each
 * item drove uncapped worker-side model spend.
 *
 * The enqueuing principal now travels in the job payload under
 * `principal_id` (stamped additively by withTransactionalEnqueue), and this
 * wrapper turns it back into a usage scope, so extraction, verification,
 * embedding, skill advance and research conclusion are charged to the user who
 * caused them. It is deliberately tolerant: a payload without the key — every
 * job enqueued before this change, and the recurring instance-wide jobs that
 * no user caused — simply runs unattributed, exactly as it did before.
 */
export function attributedTask(jobType: string, task: Task): Task {
  return (rawPayload, helpers) =>
    runWithUsageContext(() => {
      const principalId = (rawPayload as Record<string, unknown> | null)?.[JOB_PRINCIPAL_KEY];
      if (typeof principalId === 'string' && principalId) setUsageUser(principalId);
      // Task family is recorded for reporting only; it never affects a cap.
      setUsageTaskFamily(jobType);
      return task(rawPayload, helpers);
    });
}

export function buildTaskList(db: Db, deps: WorkerTaskDeps): TaskList {
  // Single-flight wrapper for the RECURRING nightly jobs: a slow run
  // must not overlap the next cron fire (or a DST double-fire). The named
  // advisory lock lets the second concurrent runner skip cleanly instead of
  // running in parallel. These jobs are idempotent by construction, so a skip is
  // safe — the next scheduled pass repairs anything missed.
  const recurring =
    (name: string, body: () => Promise<void>): (() => Promise<void>) =>
    async () => {
      const outcome = await runSingleFlight(db, name, body);
      if (!outcome.ran) {
        deps.log({ job: name }, `${name} skipped, another run holds the single-flight lock`);
      }
    };
  const tasks: TaskList = {
    echo: idempotentTask(db, 'echo', async (tx, payload) => {
      // No org, deliberately (V2.0 item 3.7): the outbox round-trip demo
      // belongs to no user and no org.
      await writeAudit(tx, {
        actor: 'worker:echo',
        action: 'echo',
        entityType: payload.source_type,
        entityId: payload.source_id,
        detail: { message: payload['message'] ?? null },
      });
    }),

    // One pipeline job per source item; the six stages run inside the
    // idempotency transaction, so retries never leave partial memories.
    [INGESTION_PIPELINE_JOB_TYPE]: idempotentTask(
      db,
      INGESTION_PIPELINE_JOB_TYPE,
      async (tx, payload) => {
        const summary = await deps.pipeline.run(tx, payload, deps.log);
        deps.log(
          {
            source_type: summary.sourceType,
            source_id: summary.sourceId,
            chunks: summary.chunks,
            extracted: summary.extracted,
            ...summary.verdicts,
            admitted_active: summary.admitted.active,
            admitted_uncertain: summary.admitted.uncertain,
            // Counts, never content: how many facts the admission line withheld
            // (V2.0 item 3.3). Each one is in the suppressed-fact log.
            not_admitted: summary.notAdmitted,
            embedded: summary.embedded,
            skipped: summary.skipped ?? null,
          },
          'ingestion pipeline completed',
        );
        // Research conclusion trigger: when this was a run's
        // web page and every page of the run has settled, enqueue the
        // conclusion — in THIS transaction, so the enqueue commits with the
        // page's own job_execution claim and can never be lost between them.
        // Web's own follow-on, not per-type dispatch: research runs conclude
        // when their last page settles. `satisfies` pins the literal to a
        // registered source type so it cannot silently drift.
        if (payload.source_type === ('web' satisfies SourceTypeKey)) {
          await deps.researchConcluder.afterPageProcessed(tx, payload.source_id);
        }
      },
    ),

    // The research conclusion: synthesise + STORE the run's
    // answer once its last page settled — whether or not anyone is watching,
    // so leaving the chat mid-research no longer loses the response. A plain
    // task (like the passport export): conclusion is idempotent by
    // construction (only an 'approved' run concludes; 'concluded' is
    // terminal), failures retry with backoff and park in dead_letter with the
    // run still approved (visible, retryable).
    [RESEARCH_CONCLUDE_JOB_TYPE]: async (rawPayload) => {
      const runId = (rawPayload as { source_id?: unknown }).source_id;
      if (typeof runId !== 'string' || !runId) return;
      const { concluded } = await deps.researchSynthesis.concludeRun(runId);
      deps.log({ source_id: runId, concluded }, 'research conclusion completed');
    },

    // The skill advance: execute every step of a
    // running skill run that can run now, checkpoint each, and stop where the
    // run must wait (extraction settling — the settle-watcher re-enqueues).
    // A plain task like the conclusion: re-runnable by design (steps
    // compare-and-set, searches recorded, capture guarded by existing pages);
    // failures retry with backoff and park visibly in dead_letter with the
    // failing step marked on the run's log.
    [SKILL_ADVANCE_JOB_TYPE]: async (rawPayload) => {
      const runId = (rawPayload as { source_id?: unknown }).source_id;
      if (typeof runId !== 'string' || !runId) return;
      const { advanced } = await deps.skillEngine.advance(runId);
      deps.log({ source_id: runId, advanced }, 'skill advance completed');
    },

    // Saga steps 2–3 (spec §11.1): Qdrant points + MinIO objects, then receipt
    // confirmation with chain hash + signature — all one attempt, so the
    // receipt can never confirm while an enumerated identifier could still
    // exist. Idempotency key: ('deletion_receipt', <receipt id>, this) —
    // graphile retries with backoff; exhaustion parks in dead_letter with
    // the receipt still pending.
    [DELETION_JOB_TYPE]: idempotentTask(db, DELETION_JOB_TYPE, async (tx, payload) => {
      const result = await deps.deletionExecutor.execute(tx, payload.source_id);
      deps.log(
        {
          source_type: payload.source_type,
          source_id: payload.source_id,
          already_confirmed: result.alreadyConfirmed,
          points: result.points,
          objects: result.objects,
        },
        'deletion saga external leg completed',
      );
    }),

    // The nightly integrity sweep (spec §11.1 step 4) — scheduled by the crontab in
    // worker.ts, also runnable on demand (sweep entrypoint). Deliberately NOT
    // wrapped in idempotentTask: that key fires once ever, a sweep recurs. Its
    // effects are idempotent by construction instead — alert inserts dedupe on
    // a unique index; the audit row is the run's ledger entry.
    [SWEEP_JOB_TYPE]: recurring(SWEEP_JOB_TYPE, async () => {
      const report = await deps.integritySweep.run((message) => deps.log({}, message));
      deps.log({ ...report }, 'integrity sweep completed');
    }),

    // The nightly dreaming cycle ( plain form) — scheduled
    // 03:30, after the 03:00 sweep; on demand via `npm run dream`. Like the
    // sweep, deliberately NOT idempotentTask (a recurring job, not a one-shot
    // per source); its effects are idempotent by construction — reconcile
    // tombstones, the staleness status filter, the unique open-flag index.
    [DREAM_JOB_TYPE]: recurring(DREAM_JOB_TYPE, async () => {
      const report = await deps.dreaming.run(deps.log);
      deps.log({ ...report }, 'dreaming cycle completed (scheduled)');
    }),

    // Extract-and-discard staging cleanup: deletes the transient
    // staging object once its extraction is durable (enqueued by the pipeline
    // in the memories' transaction), plus a delayed backstop enqueued at upload
    // that fires even if extraction never succeeded. Absent object = success.
    // A plain task (not idempotentTask): the delete is idempotent by nature and
    // deliberately re-runnable.
    [FILE_DISCARD_CLEANUP_JOB_TYPE]: async (rawPayload) => {
      const stagingKey = (rawPayload as { source_id?: unknown }).source_id;
      if (typeof stagingKey !== 'string' || !stagingKey) return;
      await deps.objects.deleteObject(stagingKey);
      deps.log({ source_id: stagingKey }, 'discard staging object deleted');
    },

    // Approval execution — the ONLY place a consequential effect
    // runs. Guarded key ('approval', <id>, this): a duplicate delivery claims
    // nothing and the effect runs at most once; the executor also refuses any
    // row not in `approved`. The confirm endpoint (app) only enqueued this.
    [APPROVAL_EXECUTE_JOB_TYPE]: idempotentTask(
      db,
      APPROVAL_EXECUTE_JOB_TYPE,
      async (tx, payload) => {
        const { afterCommit, ...result } = await deps.approvalExecutor.execute(
          tx,
          payload.source_id,
        );
        deps.log(
          { source_type: payload.source_type, source_id: payload.source_id, ...result },
          'approval execution completed',
        );
        // the bulk-outdate effect's Qdrant payload sync runs here, AFTER
        // the transaction commits and its row locks release.
        return afterCommit;
      },
    ),

    // The approval expiry pass (cron, every 5 min): pending approvals past
    // their expires_at → expired. Like the sweep, NOT idempotentTask (recurring,
    // not one-shot per key); it is idempotent by construction (a second pass
    // finds none still pending-and-past).
    [APPROVAL_EXPIRY_JOB_TYPE]: recurring(APPROVAL_EXPIRY_JOB_TYPE, async () => {
      const expired = await deps.approvalService.expireStale();
      deps.log({ expired }, 'approval expiry pass completed');
    }),

    // The Memory Passport export (spec §11.4) — worker-run because it
    // can be large (spec §15.4). A plain task: assembly re-reads through the gated
    // interfaces and writes an idempotent object + status, so a retry overwrites
    // rather than duplicates. On error the row is marked failed (visible in
    // Settings) and rethrown so graphile retries with backoff; a persistent
    // failure parks in dead_letter with the row failed.
    [PASSPORT_EXPORT_JOB_TYPE]: async (rawPayload) => {
      const exportId = (rawPayload as { source_id?: unknown }).source_id;
      if (typeof exportId !== 'string' || !exportId) return;
      try {
        const result = await deps.passportExecutor.run(exportId, new Date());
        deps.log(
          { source_id: exportId, size_bytes: result.sizeBytes, published: result.published },
          result.published
            ? 'passport export ready'
            : 'passport export expired by a source deletion while assembling; object discarded',
        );
      } catch (error) {
        await deps.passportExecutor.fail(
          exportId,
          error instanceof Error ? error.message : 'export failed',
        );
        throw error;
      }
    },

    // The hourly Passport retention pass (spec §11.4): deletes ready export objects
    // past their expiry and marks the rows expired — the "short-lived
    // downloadable" promise. Recurring + idempotent by construction (an expired
    // row is skipped next pass); single-flight so a slow run never overlaps.
    [PASSPORT_RETENTION_JOB_TYPE]: recurring(PASSPORT_RETENTION_JOB_TYPE, async () => {
      const report = await deps.passportExecutor.runRetention(new Date());
      deps.log({ ...report }, 'passport retention pass completed');
    }),

    // Prune refused-mail records past the retention window (/GAP-6) —
    // bounds the retained third-party sender PII and the table's growth on the
    // public inbound port. Recurring + idempotent; single-flight.
    [EMAIL_REFUSAL_RETENTION_JOB_TYPE]: recurring(EMAIL_REFUSAL_RETENTION_JOB_TYPE, async () => {
      const removed = await deps.allowlist.pruneRefusalsOlderThan();
      deps.log({ removed }, 'email refusal retention pass completed');
    }),

    // Prune extraction-gate refusal records past the retention window (V2.1
    // item 4.3): the ledger is metadata-only, so this is growth hygiene, the
    // same shape as the email refusal prune. Recurring + idempotent;
    // single-flight.
    [EXTRACTION_REFUSAL_RETENTION_JOB_TYPE]: recurring(
      EXTRACTION_REFUSAL_RETENTION_JOB_TYPE,
      async () => {
        const removed = await deps.extractionGate.pruneRefusalsOlderThan();
        deps.log({ removed }, 'extraction refusal retention pass completed');
      },
    ),

    // The conversation auto-title: one pipeline-tier
    // call naming an untitled thread from its opening messages. Idempotency
    // key ('chat_conversation', <conversation id>, this) — one attempt chain
    // per conversation; the guarded UPDATE inside re-checks that no manual
    // rename landed, so the user's title always wins.
    [CONVERSATION_TITLE_JOB_TYPE]: idempotentTask(
      db,
      CONVERSATION_TITLE_JOB_TYPE,
      async (tx, payload) => {
        const { titled } = await deps.conversationTitler.run(tx, payload.source_id);
        deps.log(
          { source_type: payload.source_type, source_id: payload.source_id, titled },
          'conversation title job completed',
        );
      },
    ),

    // The transient attachment read (V2.2 item 5.1): reads a "don't remember
    // this file" attachment's staged bytes once through the laddered reader,
    // stores the text on the chat-owned row, and schedules the bytes'
    // deletion in the same transaction. Idempotency key
    // ('chat', <attachment id>, this) — a duplicate delivery skips; an
    // unreadable file is recorded on the row as an honest outcome, so only
    // infrastructure errors retry.
    [CHAT_ATTACHMENT_READ_JOB_TYPE]: idempotentTask(
      db,
      CHAT_ATTACHMENT_READ_JOB_TYPE,
      async (tx, payload) => {
        const { read } = await deps.attachmentReader.run(tx, payload.source_id);
        deps.log(
          { source_type: payload.source_type, source_id: payload.source_id, read },
          'chat attachment read completed',
        );
      },
    ),

    // Embeds an edit's supersession successor. Idempotency key
    // ('memory', <memory id>, 'memory.embed') — a duplicate delivery skips.
    [MEMORY_EMBED_JOB_TYPE]: idempotentTask(db, MEMORY_EMBED_JOB_TYPE, async (tx, payload) => {
      const { embedded } = await runMemoryEmbedJob(tx, deps.memoryStore, deps.gateway, payload);
      deps.log(
        { source_type: payload.source_type, source_id: payload.source_id, embedded },
        'memory embed job completed',
      );
    }),
  };

  // Every task runs inside a usage scope (SEC-10) — no registration site can
  // forget it, and a task added later is metered by construction.
  return Object.fromEntries(
    Object.entries(tasks).map(([jobType, task]) => [
      jobType,
      attributedTask(jobType, task as Task),
    ]),
  );
}
