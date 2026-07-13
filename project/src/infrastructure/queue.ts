import type { Task } from 'graphile-worker';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from './db';
import { deadLetter, jobExecution } from './persistence/tables';

/** The §A.3 idempotency key: one row in job_execution = the job ran (or was cancelled). */
export interface JobIdempotencyKey {
  sourceType: string;
  sourceId: string;
  jobType: string;
}

const advisoryKeySql = (key: JobIdempotencyKey) =>
  sql`hashtextextended(${key.jobType} || ':' || ${key.sourceType} || ':' || ${key.sourceId}, 0)`;

/**
 * Takes the transaction-scoped advisory lock that identifies a RUNNING
 * idempotent job for this key. `idempotentTask` acquires it before the
 * idempotency-row insert, so holding it (or failing to take it) is proof about
 * in-flight runs: `tryJobRunLock` returning true guarantees no run of this key
 * is currently in flight — which makes a subsequent `consumeIdempotencyKey`
 * non-blocking (only a COMMITTED row can conflict, and that conflict resolves
 * instantly). Released automatically at transaction end.
 */
export async function acquireJobRunLock(tx: Tx, key: JobIdempotencyKey): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${advisoryKeySql(key)})`);
}

/** Non-blocking probe of the run lock: false = a run of this key is in flight. */
export async function tryJobRunLock(tx: Tx, key: JobIdempotencyKey): Promise<boolean> {
  const result = await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(${advisoryKeySql(key)}) AS locked`,
  );
  return (result.rows[0] as { locked: boolean }).locked;
}

/**
 * Marks the idempotency key consumed WITHOUT running the job — how the deletion
 * saga cancels a source's queued-but-not-started ingestion inside its own
 * transaction (QS-5): the next delivery of the job finds the key and skips.
 * Returns false when the key was already consumed (the job already ran).
 * Callers must hold (or have probed) the run lock first — see acquireJobRunLock.
 */
export async function consumeIdempotencyKey(tx: Tx, key: JobIdempotencyKey): Promise<boolean> {
  const claimed = await tx
    .insert(jobExecution)
    .values({ sourceType: key.sourceType, sourceId: key.sourceId, jobType: key.jobType })
    .onConflictDoNothing()
    .returning({ id: jobExecution.id });
  return claimed.length > 0;
}

const idempotentPayloadSchema = z
  .object({ source_type: z.string().min(1), source_id: z.string().min(1) })
  .passthrough();

export type IdempotentJobPayload = z.infer<typeof idempotentPayloadSchema>;

/**
 * An after-commit continuation a handler may return: work that must run AFTER
 * the idempotency transaction commits, never inside it (QS-27). It executes
 * best-effort — a failure is logged, not retried, and never dead-letters the
 * job (the committed effect already happened). Use only for idempotent,
 * externally-reconciled side effects (e.g. Qdrant payload sync, whose nightly
 * consistency sweep is the backstop — decision 0025). Returning nothing keeps
 * the classic contract unchanged.
 */
export type AfterCommit = () => Promise<void>;

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
 * - **After-commit** (QS-27): a handler may return an {@link AfterCommit} thunk,
 *   run once the transaction has committed and its row locks released — for work
 *   that must not be held inside the lock window (per-row Qdrant HTTP calls).
 */
export function idempotentTask(
  db: Db,
  jobType: string,
  handler: (tx: Tx, payload: IdempotentJobPayload) => Promise<void | AfterCommit>,
): Task {
  return async (rawPayload, helpers) => {
    const payload = idempotentPayloadSchema.parse(rawPayload);
    try {
      let afterCommit: AfterCommit | undefined;
      await db.transaction(async (tx) => {
        // Run lock BEFORE the claim insert — the invariant other transactions
        // rely on (QS-5): any in-flight run of this key holds the advisory
        // lock, so `tryJobRunLock` success proves no uncommitted claim row
        // exists and a cancellation insert can never block on one.
        await acquireJobRunLock(tx, {
          sourceType: payload.source_type,
          sourceId: payload.source_id,
          jobType,
        });
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
        afterCommit = (await handler(tx, payload)) ?? undefined;
      });
      // Runs only after a successful commit (a duplicate-skip leaves it unset).
      // Best-effort by contract: log and move on — the effect is already durable
      // and the after-commit work is externally reconciled (QS-27).
      if (afterCommit) {
        try {
          await afterCommit();
        } catch (error) {
          helpers.logger.error(
            `after-commit step for ${jobType} failed (effect committed; will reconcile): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
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
