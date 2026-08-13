import type { Task } from 'graphile-worker';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Db, DbOrTx, Tx } from './db';
import { deadLetter, jobExecution } from './persistence/tables';
import { describeErrorLine } from './error-scrub';

const DEAD_LETTER_WRITE_ATTEMPTS = 3;
const DEAD_LETTER_RETRY_MS = 200;

/** How long a job waits before re-checking for a model provider. */
export const AWAITING_MODEL_PROVIDER_RETRY_MS = 60_000;

/**
 * Work queued before a model provider exists WAITS instead of failing: no
 * provider configured is the normal first-run state, and burning a job's
 * retries against a state only an administrator can change would dead-letter
 * every capture and degrade health over something that is not broken. Matched
 * by name (walking the cause chain) rather than by class, because the seam's
 * error class must not be imported beneath the seam.
 */
export function isAwaitingModelProvider(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (current.name === 'ModelGatewayNotConfiguredError') return true;
    current = current.cause;
  }
  return false;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The spec §15.4 idempotency key: one row in job_execution = the job ran (or was cancelled). */
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
 * Single-flight guard for RECURRING jobs. The nightly
 * sweep/dream/reminders/backfill and the demo reset are NOT idempotentTask
 * (they recur, not once-per-key), so a slow run can overlap the next cron fire
 * (or a DST double-fire). This wraps a job body in a transaction-scoped
 * advisory lock keyed by name: the SECOND concurrent runner fails the try-lock
 * and skips cleanly rather than running in parallel. The body runs on separate
 * pooled connections; the lock (held on the wrapping tx's connection) is
 * released at commit. Returns { ran: false } when it skipped.
 */
export async function runSingleFlight<T>(
  db: Db,
  name: string,
  fn: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false }> {
  return db.transaction(async (tx) => {
    const got = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`cogeto:single-flight:${name}`}, 0)) AS locked`,
    );
    if (!(got.rows[0] as { locked: boolean }).locked) return { ran: false };
    const result = await fn();
    return { ran: true, result };
  });
}

/**
 * Marks the idempotency key consumed WITHOUT running the job — how the deletion
 * saga cancels a source's queued-but-not-started ingestion inside its own
 * transaction: the next delivery of the job finds the key and skips.
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

/**
 * How far a job for one source has got, read from the queue's own two ledgers:
 * a `job_execution` row under the idempotency key means it committed, a
 * `dead_letter` row for the type carrying this source id means it exhausted its
 * retries, and anything else is still queued or running.
 */
export type JobRunState = 'done' | 'failed' | 'processing';

/**
 * The narrow read side of the queue ledgers (boundary contract §2).
 *
 * `job_execution` and `dead_letter` are infrastructure's tables. Five call
 * sites in `connectors` and `retrieval` each carried their own byte-identical
 * copy of this pair of queries against tables they do not own, legalised by the
 * barrel re-exporting the table objects (spec §15.2). This is the one place
 * they are read; each caller maps the state to its own surface vocabulary.
 */
/**
 * Release job locks abandoned by a dead worker (issue #496). Graphile holds
 * a killed worker's locks for its four-hour reclaim window, so a rebuild or
 * restart mid-job leaves the queue showing one-processing-forever with no
 * traffic at all. Each Cogeto instance runs exactly ONE worker process (the
 * compose contract), so at ITS boot every held lock belongs to a process
 * that no longer exists and is safe to release: the single-flight advisory
 * locks guard re-entry and every job is idempotent by contract. Returns how
 * many locks were released, for the boot log.
 */
export async function releaseAbandonedJobLocks(db: DbOrTx): Promise<number> {
  const result = await db.execute(sql`
    UPDATE graphile_worker._private_jobs
       SET locked_at = NULL, locked_by = NULL
     WHERE locked_at IS NOT NULL
  `);
  return (result as unknown as { rowCount?: number }).rowCount ?? 0;
}

export async function jobRunState(executor: DbOrTx, key: JobIdempotencyKey): Promise<JobRunState> {
  const done = await executor
    .select({ id: jobExecution.id })
    .from(jobExecution)
    .where(
      and(
        eq(jobExecution.sourceType, key.sourceType),
        eq(jobExecution.sourceId, key.sourceId),
        eq(jobExecution.jobType, key.jobType),
      ),
    )
    .limit(1);
  if (done.length > 0) return 'done';

  // A dead-lettered job is identified by its type plus the source id INSIDE the
  // stored payload: the row predates any per-source column and carries the job
  // as it was delivered.
  const failed = await executor
    .select({ id: deadLetter.id })
    .from(deadLetter)
    .where(
      and(
        eq(deadLetter.jobType, key.jobType),
        sql`${deadLetter.payload}->>'source_id' = ${key.sourceId}`,
      ),
    )
    .limit(1);
  return failed.length > 0 ? 'failed' : 'processing';
}

/**
 * The queue's operational surface (boundary contract §2, V2.0 item 3.6 part 2).
 *
 * `job_execution`, `dead_letter` and the `graphile_worker` schema are
 * infrastructure's. The System dashboard's queue view used to run these queries
 * itself from the composition root (recorded exception B9); the SQL is
 * unchanged, it just lives with the tables now. Presentation, the admin gate
 * and the DTO shapes stay with the caller.
 */

/** One row of the live queue, joined to the payload the public view omits. */
export interface QueuedJobRow {
  jobType: string;
  payload: Record<string, unknown> | null;
  runAt: Date | null;
  attempts: number;
  maxAttempts: number;
  lockedAt: Date | null;
  lastError: string | null;
}

/** One completed run from the idempotency ledger. */
export interface JobExecutionRow {
  jobType: string;
  sourceType: string;
  sourceId: string;
  executedAt: Date;
}

/** One parked job: the payload as delivered, plus why it stopped. */
export interface DeadLetterRow {
  id: string;
  jobType: string;
  payload: Record<string, unknown> | null;
  error: string;
  attempts: number;
  failedAt: Date;
}

const toDate = (value: string | Date | null | undefined): Date | null =>
  value == null ? null : new Date(value);

/** The live queue, soonest first. The public `jobs` view omits payload (it
 * lives in `_private_jobs`); join on id to recover source_type/source_id. */
export async function listQueuedJobs(executor: DbOrTx, limit = 200): Promise<QueuedJobRow[]> {
  const result = await executor.execute(sql`
      SELECT j.task_identifier, pj.payload, j.run_at, j.attempts, j.max_attempts,
             j.locked_at, j.last_error
      FROM graphile_worker.jobs j
      JOIN graphile_worker._private_jobs pj ON pj.id = j.id
      ORDER BY j.run_at ASC
      LIMIT ${limit}
    `);
  return (
    result.rows as Array<{
      task_identifier: string;
      payload: Record<string, unknown> | null;
      run_at: string | Date | null;
      attempts: number;
      max_attempts: number;
      locked_at: string | Date | null;
      last_error: string | null;
    }>
  ).map((r) => ({
    jobType: r.task_identifier,
    payload: r.payload,
    runAt: toDate(r.run_at),
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    lockedAt: toDate(r.locked_at),
    lastError: r.last_error,
  }));
}

/** The most recently committed runs, newest first. */
export async function recentJobExecutions(executor: DbOrTx, limit = 8): Promise<JobExecutionRow[]> {
  const rows = await executor
    .select()
    .from(jobExecution)
    .orderBy(desc(jobExecution.executedAt))
    .limit(limit);
  return rows.map((row) => ({
    jobType: row.jobType,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    executedAt: row.executedAt,
  }));
}

/** Parked jobs, most recent failure first. */
export async function listDeadLetters(executor: DbOrTx, limit = 100): Promise<DeadLetterRow[]> {
  const rows = await executor
    .select()
    .from(deadLetter)
    .orderBy(desc(deadLetter.failedAt))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    jobType: row.jobType,
    payload: (row.payload ?? null) as Record<string, unknown> | null,
    error: row.error,
    attempts: row.attempts,
    failedAt: row.failedAt,
  }));
}

/** Totals for the queue summary: parked jobs, and runs ever committed. */
export async function queueTotals(
  executor: DbOrTx,
): Promise<{ deadLettered: number; completed: number }> {
  const [{ n: deadLettered }] = (
    await executor.execute(sql`SELECT count(*)::int AS n FROM dead_letter`)
  ).rows as [{ n: number }];
  const [{ n: completed }] = (
    await executor.execute(sql`SELECT count(*)::int AS n FROM job_execution`)
  ).rows as [{ n: number }];
  return { deadLettered, completed };
}

/**
 * Re-enqueues a parked job and removes its dead-letter row in ONE transaction,
 * handing the caller the row it replayed so an audit entry can be written in
 * the same transaction. Returns null when the id is unknown.
 *
 * Double effects are impossible however often a job is retried: `idempotentTask`
 * claims the (source_type, source_id, job_type) key before the handler's
 * effect, so a re-run of completed work skips.
 */
export async function retryDeadLetter(
  tx: Tx,
  id: string,
  maxAttempts = 10,
): Promise<DeadLetterRow | null> {
  const rows = await tx.select().from(deadLetter).where(eq(deadLetter.id, id)).for('update');
  const row = rows[0];
  if (!row) return null;
  await tx.execute(sql`
        SELECT graphile_worker.add_job(
          ${row.jobType},
          payload := ${JSON.stringify(row.payload ?? {})}::json,
          max_attempts := ${maxAttempts}
        )
      `);
  await tx.delete(deadLetter).where(eq(deadLetter.id, id));
  return {
    id: row.id,
    jobType: row.jobType,
    payload: (row.payload ?? null) as Record<string, unknown> | null,
    error: row.error,
    attempts: row.attempts,
    failedAt: row.failedAt,
  };
}

/**
 * Clears a source's idempotency key so its pipeline job can run AGAIN, and
 * enqueues it (V2.1 item 4.1, reprocessing).
 *
 * Every other path in the product treats the key as final, and that is right:
 * it is what makes a redelivered job a no-op. Reprocessing is the one deliberate
 * exception, and it exists because a document that could not be read is not
 * finished with. The bytes are retained, so a scan that needed vision on an
 * instance that had none becomes readable the moment vision is configured, and
 * without this it would stay unread forever.
 *
 * The dead-letter row goes too: a file that failed to read has one, and leaving
 * it would show the file as permanently failed next to its successful re-read.
 *
 * Callers audit the decision. This function only makes the re-run possible.
 */
export async function clearIdempotencyForReprocess(
  tx: Tx,
  key: JobIdempotencyKey,
): Promise<{ clearedExecution: boolean; clearedDeadLetters: number }> {
  const removed = await tx
    .delete(jobExecution)
    .where(
      and(
        eq(jobExecution.sourceType, key.sourceType),
        eq(jobExecution.sourceId, key.sourceId),
        eq(jobExecution.jobType, key.jobType),
      ),
    )
    .returning({ id: jobExecution.id });
  const deadLetters = await tx
    .delete(deadLetter)
    .where(
      and(
        eq(deadLetter.jobType, key.jobType),
        sql`${deadLetter.payload}->>'source_id' = ${key.sourceId}`,
      ),
    )
    .returning({ id: deadLetter.id });
  return { clearedExecution: removed.length > 0, clearedDeadLetters: deadLetters.length };
}

const idempotentPayloadSchema = z.looseObject({
  source_type: z.string().min(1),
  source_id: z.string().min(1),
});

export type IdempotentJobPayload = z.infer<typeof idempotentPayloadSchema>;

/**
 * An after-commit continuation a handler may return: work that must run AFTER
 * the idempotency transaction commits, never inside it. It executes
 * best-effort — a failure is logged, not retried, and never dead-letters the
 * job (the committed effect already happened). Use only for idempotent,
 * externally-reconciled side effects (e.g. Qdrant payload sync, whose nightly
 * consistency sweep is the backstop). Returning nothing keeps
 * the classic contract unchanged.
 */
export type AfterCommit = () => Promise<void>;

/**
 * Wraps a job handler with the spec §15.4 contract
 *
 * - **Idempotency**: the handler's effect and an INSERT into job_execution under
 *   the unique key (source_type, source_id, job_type) share one transaction —
 *   at-most-once effect. A duplicate delivery finds the key and skips.
 * - **Retries with backoff**: a thrown error lets Graphile Worker retry with its
 *   exponential backoff; the rolled-back transaction leaves no partial effect.
 * - **Dead-letter**: when the final attempt fails, the job is recorded in
 *   dead_letter (dashboard-visible) instead of retrying forever.
 * - **After-commit**: a handler may return an {@link AfterCommit} thunk,
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
        // rely on: any in-flight run of this key holds the advisory
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
      // and the after-commit work is externally reconciled.
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
      // No model provider configured: the transaction rolled back (no partial
      // effect, the idempotency claim released), so the SAME job is re-added
      // a minute out and this delivery completes. The job key collapses
      // repeated waits into one scheduled row, attempts never burn, nothing
      // dead-letters, and the chain drains by itself once an administrator
      // configures a provider — no restart, no replay.
      if (isAwaitingModelProvider(error)) {
        await helpers.addJob(jobType, payload, {
          runAt: new Date(Date.now() + AWAITING_MODEL_PROVIDER_RETRY_MS),
          jobKey: `awaiting-model-provider:${jobType}:${payload.source_type}:${payload.source_id}`,
          jobKeyMode: 'replace',
        });
        helpers.logger.warn(
          `job ${jobType}(${payload.source_type}, ${payload.source_id}) is waiting: no model ` +
            `provider is configured. It retries every ${AWAITING_MODEL_PROVIDER_RETRY_MS / 1000}s ` +
            `and completes once an administrator adds one under Providers.`,
        );
        return;
      }
      const { attempts, max_attempts: maxAttempts } = helpers.job;
      if (attempts >= maxAttempts) {
        // Final attempt: park in dead_letter (own transaction — the failed one
        // rolled back) and complete the job. The error is SCRUBBED of model
        // output before it lands in the column. The write itself is
        // retried — a lost dead_letter row would make health show green
        // over lost work; if every retry fails we re-throw so graphile keeps the
        // job as permanently-failed, which the health graphile-permfail check
        // detects (also).
        for (let writeAttempt = 1; ; writeAttempt++) {
          try {
            await db.insert(deadLetter).values({
              jobType,
              payload,
              error: describeErrorLine(error),
              attempts,
            });
            helpers.logger.error(`job ${jobType} dead-lettered after ${attempts} attempts`);
            return;
          } catch (writeError) {
            if (writeAttempt >= DEAD_LETTER_WRITE_ATTEMPTS) {
              helpers.logger.error(
                `job ${jobType}: dead_letter write failed ${writeAttempt}x, re-throwing so it ` +
                  `parks as graphile permanent-failure (health will flag it): ` +
                  describeErrorLine(writeError),
              );
              throw error; // graphile keeps the exhausted job; health detects it
            }
            await sleep(DEAD_LETTER_RETRY_MS * writeAttempt);
          }
        }
      }
      throw error;
    }
  };
}

/**
 * Waits until graphile-worker has committed all job bookkeeping: no job row
 * still holds a lock (V2.0 item 3.6 part 4, closing B21 — the queue schema is
 * named only by its owner; the Testcontainers harness calls THIS instead of
 * reading `_private_jobs` itself). Since graphile 0.17 a failed attempt's
 * write (attempts++, lock release, backoff run_at) can land AFTER `runOnce`
 * resolves; a caller that immediately reschedules races it. Test support: no
 * production path waits on the queue.
 */
export async function settleQueueBookkeeping(pool: Pool, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query(
      'SELECT count(*)::int AS locked FROM graphile_worker._private_jobs WHERE locked_by IS NOT NULL',
    );
    if (rows[0].locked === 0) return;
    if (Date.now() > deadline) {
      throw new Error('graphile job bookkeeping did not settle: rows still locked');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Set-based twin of {@link jobRunState} for one page of catalog refs (V2.2
 * item 5.2): two grouped queries instead of two per row. Refs absent from the
 * result are 'processing' (queued or in flight), exactly as in the singular
 * read.
 */
export async function jobRunStates(
  executor: DbOrTx,
  refs: readonly { sourceType: string; sourceId: string }[],
  jobType: string,
): Promise<Map<string, JobRunState>> {
  const out = new Map<string, JobRunState>();
  if (refs.length === 0) return out;
  const pairs = refs.map((ref) => sql`(${ref.sourceType}, ${ref.sourceId})`);
  const done = await executor
    .select({ sourceType: jobExecution.sourceType, sourceId: jobExecution.sourceId })
    .from(jobExecution)
    .where(
      and(
        eq(jobExecution.jobType, jobType),
        sql`(${jobExecution.sourceType}, ${jobExecution.sourceId}) IN (${sql.join(pairs, sql`, `)})`,
      ),
    );
  for (const row of done) out.set(`${row.sourceType} ${row.sourceId}`, 'done');
  const ids = refs
    .filter((ref) => !out.has(`${ref.sourceType} ${ref.sourceId}`))
    .map((ref) => ref.sourceId);
  if (ids.length > 0) {
    const failed = await executor
      .select({ sourceId: sql<string>`${deadLetter.payload}->>'source_id'` })
      .from(deadLetter)
      .where(
        and(
          eq(deadLetter.jobType, jobType),
          sql`${deadLetter.payload}->>'source_id' IN (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        ),
      );
    const failedIds = new Set(failed.map((row) => row.sourceId));
    for (const ref of refs) {
      const key = `${ref.sourceType} ${ref.sourceId}`;
      if (!out.has(key)) out.set(key, failedIds.has(ref.sourceId) ? 'failed' : 'processing');
    }
  } else {
    // Every ref already resolved 'done'.
  }
  for (const ref of refs) {
    const key = `${ref.sourceType} ${ref.sourceId}`;
    if (!out.has(key)) out.set(key, 'processing');
  }
  return out;
}
