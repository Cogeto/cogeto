import type { TaskList } from 'graphile-worker';
import { idempotentTask, runSingleFlight, writeAudit } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import {
  DREAM_JOB_TYPE,
  FILE_DISCARD_CLEANUP_JOB_TYPE,
  INGESTION_PIPELINE_JOB_TYPE,
  TASK_DERIVE_JOB_TYPE,
  TASKS_BACKFILL_JOB_TYPE,
} from '../ingestion/index';
import type { DreamingService, IngestionPipeline, PipelineLog } from '../ingestion/index';
import { TASKS_REMINDERS_JOB_TYPE } from '../tasks/index';
import type { TasksEngine } from '../tasks/index';
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
import type { ModelGateway } from '../model-gateway/index';

export interface WorkerTaskDeps {
  pipeline: IngestionPipeline;
  memoryStore: MemoryStore;
  deletionExecutor: DeletionExecutor;
  integritySweep: IntegritySweep;
  dreaming: DreamingService;
  tasksEngine: TasksEngine;
  approvalService: ApprovalService;
  approvalExecutor: ApprovalExecutor;
  passportExecutor: PassportExportExecutor;
  objects: MemoryObjectStore;
  gateway: ModelGateway;
  /** Bound to pino by the worker entrypoint. Counts only — never content. */
  log: PipelineLog;
}

/**
 * The worker's task registry (composition root — modules contribute tasks as
 * their slices ship). `echo` is the §A.3 round-trip demo: its observable effect
 * is one audit row, written in the idempotency transaction, so a duplicate
 * delivery provably changes nothing.
 */
export function buildTaskList(db: Db, deps: WorkerTaskDeps): TaskList {
  // Single-flight wrapper for the RECURRING nightly jobs (QS-39): a slow run
  // must not overlap the next cron fire (or a DST double-fire). The named
  // advisory lock lets the second concurrent runner skip cleanly instead of
  // running in parallel. These jobs are idempotent by construction, so a skip is
  // safe — the next scheduled pass repairs anything missed.
  const recurring =
    (name: string, body: () => Promise<void>): (() => Promise<void>) =>
    async () => {
      const outcome = await runSingleFlight(db, name, body);
      if (!outcome.ran) {
        deps.log({ job: name }, `${name} skipped — another run holds the single-flight lock`);
      }
    };
  return {
    echo: idempotentTask(db, 'echo', async (tx, payload) => {
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
            embedded: summary.embedded,
            skipped: summary.skipped ?? null,
          },
          'ingestion pipeline completed',
        );
      },
    ),

    // Saga steps 2–3 (§A.7): Qdrant points + MinIO objects, then receipt
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

    // The nightly integrity sweep (§A.7 step 4) — scheduled by the crontab in
    // worker.ts, also runnable on demand (sweep entrypoint). Deliberately NOT
    // wrapped in idempotentTask: that key fires once ever, a sweep recurs. Its
    // effects are idempotent by construction instead — alert inserts dedupe on
    // a unique index; the audit row is the run's ledger entry.
    [SWEEP_JOB_TYPE]: recurring(SWEEP_JOB_TYPE, async () => {
      const report = await deps.integritySweep.run((message) => deps.log({}, message));
      deps.log({ ...report }, 'integrity sweep completed');
    }),

    // The nightly dreaming cycle (§B.6 plain form; decision 0011) — scheduled
    // 03:30, after the 03:00 sweep; on demand via `npm run dream`. Like the
    // sweep, deliberately NOT idempotentTask (a recurring job, not a one-shot
    // per source); its effects are idempotent by construction — reconcile
    // tombstones, the staleness status filter, the unique open-flag index.
    [DREAM_JOB_TYPE]: recurring(DREAM_JOB_TYPE, async () => {
      const report = await deps.dreaming.run(deps.log);
      deps.log({ ...report }, 'dreaming cycle completed (scheduled)');
    }),

    // Task derivation + judgments per processed source (decision 0013 ruling
    // 2): the pipeline enqueues it transactionally after stage 6; the engine
    // derives (UNIQUE-idempotent) and judges closure/condition, all inside
    // this job's idempotency transaction.
    [TASK_DERIVE_JOB_TYPE]: idempotentTask(db, TASK_DERIVE_JOB_TYPE, async (tx, payload) => {
      const report = await deps.tasksEngine.processSource(
        tx,
        payload.source_type,
        payload.source_id,
      );
      deps.log(
        { source_type: payload.source_type, source_id: payload.source_id, ...report },
        'task engine pass completed',
      );
    }),

    // The idempotent historical backfill (0013 ruling 2): enqueued once by
    // migration 0014 and nightly by the dreaming cycle. Like the sweep, NOT
    // idempotentTask — recurring; the UNIQUE deriving-memory constraint makes
    // its effects idempotent instead.
    [TASKS_BACKFILL_JOB_TYPE]: recurring(TASKS_BACKFILL_JOB_TYPE, async () => {
      const report = await deps.tasksEngine.backfill((message) => deps.log({}, message));
      deps.log({ ...report }, 'tasks backfill completed');
    }),

    // The nightly task reminders pass (F3 handoff §2) — scheduled 03:40 by the
    // crontab in worker.ts, after the dreaming cycle's dormancy sync. Like the
    // sweep, NOT idempotentTask (recurring, not one-shot per key); it is
    // idempotent by construction — reminders stamp only when unset, so a
    // re-delivered pass raises nothing new.
    [TASKS_REMINDERS_JOB_TYPE]: recurring(TASKS_REMINDERS_JOB_TYPE, async () => {
      const report = await deps.tasksEngine.runReminders((message) => deps.log({}, message));
      deps.log({ ...report }, 'task reminders pass completed');
    }),

    // Extract-and-discard staging cleanup (§A.9, O1-C): deletes the transient
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

    // Approval execution (§A.8, O1-B) — the ONLY place a consequential effect
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
        // QS-27: the bulk-outdate effect's Qdrant payload sync runs here, AFTER
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

    // The Memory Passport export (§B.5, decision 0029) — worker-run because it
    // can be large (§A.3). A plain task: assembly re-reads through the gated
    // interfaces and writes an idempotent object + status, so a retry overwrites
    // rather than duplicates. On error the row is marked failed (visible in
    // Settings) and rethrown so graphile retries with backoff; a persistent
    // failure parks in dead_letter with the row failed.
    [PASSPORT_EXPORT_JOB_TYPE]: async (rawPayload) => {
      const exportId = (rawPayload as { source_id?: unknown }).source_id;
      if (typeof exportId !== 'string' || !exportId) return;
      try {
        const result = await deps.passportExecutor.run(exportId, new Date());
        deps.log({ source_id: exportId, size_bytes: result.sizeBytes }, 'passport export ready');
      } catch (error) {
        await deps.passportExecutor.fail(
          exportId,
          error instanceof Error ? error.message : 'export failed',
        );
        throw error;
      }
    },

    // The hourly Passport retention pass (§B.5): deletes ready export objects
    // past their expiry and marks the rows expired — the "short-lived
    // downloadable" promise. Recurring + idempotent by construction (an expired
    // row is skipped next pass); single-flight so a slow run never overlaps.
    [PASSPORT_RETENTION_JOB_TYPE]: recurring(PASSPORT_RETENTION_JOB_TYPE, async () => {
      const report = await deps.passportExecutor.runRetention(new Date());
      deps.log({ ...report }, 'passport retention pass completed');
    }),

    // Embeds an edit's supersession successor (S3-B). Idempotency key:
    // ('memory', <memory id>, 'memory.embed') — a duplicate delivery skips.
    [MEMORY_EMBED_JOB_TYPE]: idempotentTask(db, MEMORY_EMBED_JOB_TYPE, async (tx, payload) => {
      const { embedded } = await runMemoryEmbedJob(tx, deps.memoryStore, deps.gateway, payload);
      deps.log(
        { source_type: payload.source_type, source_id: payload.source_id, embedded },
        'memory embed job completed',
      );
    }),
  };
}
