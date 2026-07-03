import type { TaskList } from 'graphile-worker';
import { idempotentTask, writeAudit } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { INGESTION_PIPELINE_JOB_TYPE } from '../ingestion/index';
import type { IngestionPipeline, PipelineLog } from '../ingestion/index';

export interface WorkerTaskDeps {
  pipeline: IngestionPipeline;
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
  };
}
