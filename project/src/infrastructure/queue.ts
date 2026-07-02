import type { Task } from 'graphile-worker';
import { z } from 'zod';
import type { Db, Tx } from './db';
import { deadLetter, jobExecution } from './persistence/tables';

const idempotentPayloadSchema = z
  .object({ source_type: z.string().min(1), source_id: z.string().min(1) })
  .passthrough();

export type IdempotentJobPayload = z.infer<typeof idempotentPayloadSchema>;

/**
 * Wraps a job handler with the §A.3 contract:
 *
 * - **Idempotency**: the handler's effect and an INSERT into job_execution under
 *   the unique key (source_type, source_id, job_type) share one transaction —
 *   at-most-once effect. A duplicate delivery finds the key and skips.
 * - **Retries with backoff**: a thrown error lets Graphile Worker retry with its
 *   exponential backoff; the rolled-back transaction leaves no partial effect.
 * - **Dead-letter**: when the final attempt fails, the job is recorded in
 *   dead_letter (dashboard-visible) instead of retrying forever.
 */
export function idempotentTask(
  db: Db,
  jobType: string,
  handler: (tx: Tx, payload: IdempotentJobPayload) => Promise<void>,
): Task {
  return async (rawPayload, helpers) => {
    const payload = idempotentPayloadSchema.parse(rawPayload);
    try {
      await db.transaction(async (tx) => {
        const claimed = await tx
          .insert(jobExecution)
          .values({
            sourceType: payload.source_type,
            sourceId: payload.source_id,
            jobType,
          })
          .onConflictDoNothing()
          .returning({ id: jobExecution.id });
        if (claimed.length === 0) {
          helpers.logger.info(
            `skipping duplicate job ${jobType}(${payload.source_type}, ${payload.source_id})`,
          );
          return;
        }
        await handler(tx, payload);
      });
    } catch (error) {
      const { attempts, max_attempts: maxAttempts } = helpers.job;
      if (attempts >= maxAttempts) {
        // Final attempt: park in the dead-letter table (own transaction — the
        // failed one rolled back) and complete the job. Visibility over retry loops.
        await db.insert(deadLetter).values({
          jobType,
          payload,
          error: error instanceof Error ? error.message : String(error),
          attempts,
        });
        helpers.logger.error(`job ${jobType} dead-lettered after ${attempts} attempts`);
        return;
      }
      throw error;
    }
  };
}
