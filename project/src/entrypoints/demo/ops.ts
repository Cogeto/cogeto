import type { Pool, PoolClient } from 'pg';

/**
 * Demo-only database operations (decision 0022) — job draining, one-shot
 * dreaming, narrative back-dating, and the reset wipe. These run ONLY from demo
 * entrypoints (excluded from production images) and touch tables directly as an
 * ops tool, never as a domain module. They perform NO memory INSERTs: the world
 * is created solely by the real pipeline via the HTTP API (`demo_pipeline_real`).
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Session-level advisory lock guarding the whole reset (QS-33). Reset truncates
 * every domain table and re-seeds; two overlapping resets — a manual `demo:reset`
 * racing the worker's scheduled one, or a slow reset overlapping the next cron —
 * would truncate mid-seed and corrupt the world. The lock is database-global
 * (across processes and pools), so the standalone entrypoint and the in-worker
 * job serialize on it. Returns null when another reset already holds it. */
const DEMO_RESET_LOCK = `hashtextextended('cogeto:demo-reset', 0)`;

export async function acquireDemoResetLock(pool: Pool): Promise<PoolClient | null> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(${DEMO_RESET_LOCK}) AS locked`,
    );
    if (rows[0]?.locked) return client;
    client.release();
    return null;
  } catch (error) {
    client.release();
    throw error;
  }
}

export async function releaseDemoResetLock(client: PoolClient): Promise<void> {
  try {
    await client.query(`SELECT pg_advisory_unlock(${DEMO_RESET_LOCK})`);
  } finally {
    client.release();
  }
}

/**
 * Pending + running Graphile jobs — the quiescence signal. `excludeTask` drops a
 * task identifier from the count: when the scheduled reset drains from INSIDE
 * the worker it must not count its own running `demo_reset` job, or it would
 * wait for itself forever.
 */
export async function pendingJobs(pool: Pool, excludeTask?: string): Promise<number> {
  const { rows } = excludeTask
    ? await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM graphile_worker.jobs WHERE task_identifier <> $1',
        [excludeTask],
      )
    : await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM graphile_worker.jobs');
  return Number(rows[0]?.n ?? '0');
}

export async function deadLetterCount(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM dead_letter');
  return Number(rows[0]?.n ?? '0');
}

/**
 * Waits until the queue is empty AND stays empty across two checks (so a job
 * that just enqueued a follow-on — the pipeline enqueues task-derive/embed —
 * doesn't read as drained). Fails if any job dead-letters.
 */
export async function waitForQuiescence(
  pool: Pool,
  opts: {
    timeoutMs?: number;
    pollMs?: number;
    deadLetterBaseline?: number;
    excludeTask?: string;
  } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const pollMs = opts.pollMs ?? 500;
  const baseline = opts.deadLetterBaseline ?? (await deadLetterCount(pool));
  const deadline = Date.now() + timeoutMs;
  let clearStreak = 0;
  for (;;) {
    const dl = await deadLetterCount(pool);
    if (dl > baseline) {
      const { rows } = await pool.query<{ task_identifier: string; last_error: string | null }>(
        'SELECT task_identifier, last_error FROM dead_letter ORDER BY created_at DESC LIMIT 3',
      );
      throw new Error(
        `a job dead-lettered during seeding (dead_letter ${baseline}→${dl}): ${JSON.stringify(rows)}`,
      );
    }
    const pending = await pendingJobs(pool, opts.excludeTask);
    clearStreak = pending === 0 ? clearStreak + 1 : 0;
    if (clearStreak >= 2) return;
    if (Date.now() > deadline)
      throw new Error(`queue did not drain within ${timeoutMs}ms (pending=${pending})`);
    await sleep(pollMs);
  }
}

/** Enqueues one dreaming cycle onto the running worker (§B.6; decision 0011). */
export async function enqueueDream(pool: Pool): Promise<void> {
  await pool.query(`SELECT graphile_worker.add_job('dreaming_cycle', payload := '{}'::json)`);
}

export interface AgeEntry {
  sourceType: 'user_note' | 'chat' | 'file';
  sourceId: string;
  daysAgo: number;
}

/**
 * Back-dates the created world so it reads as weeks of accrual (decision 0022):
 * dormancy (>14 days), supersession ordering, and the digest all depend on
 * real elapsed time, which a same-second seed cannot produce. This is an UPDATE
 * of timestamps only — it never creates a memory (extraction stays real).
 */
export async function ageWorld(pool: Pool, entries: AgeEntry[]): Promise<void> {
  for (const e of entries) {
    if (e.daysAgo <= 0) continue;
    const shift = `now() - ($1::int * interval '1 day')`;
    await pool.query(
      `UPDATE memory SET created_at = ${shift}, updated_at = ${shift} WHERE source_type = $2 AND source_id = $3`,
      [e.daysAgo, e.sourceType, e.sourceId],
    );
    if (e.sourceType === 'user_note') {
      await pool.query(`UPDATE note SET created_at = ${shift} WHERE id = $2`, [
        e.daysAgo,
        e.sourceId,
      ]);
    } else if (e.sourceType === 'chat') {
      await pool.query(`UPDATE chat_message SET created_at = ${shift} WHERE id = $2`, [
        e.daysAgo,
        e.sourceId,
      ]);
    } else if (e.sourceType === 'file') {
      await pool.query(`UPDATE file_metadata SET upload_date = ${shift} WHERE object_key = $2`, [
        e.daysAgo,
        e.sourceId,
      ]);
    }
  }
}

/** Object keys of every uploaded file (for MinIO cleanup before truncation). */
export async function fileObjectKeys(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ object_key: string }>('SELECT object_key FROM file_metadata');
  return rows.map((r) => r.object_key);
}

/**
 * Truncates every domain table (decision 0022 ruling 2). The demo instance is
 * single-tenant and disposable, so wiping all app data IS wiping demo data.
 * Preserves the migration ledger and the registered prompt versions (the running
 * worker's immutability check depends on the latter). Qdrant/MinIO are cleared
 * by the caller (reindex-from-empty removes orphan points; object deletes first).
 */
export async function truncateDomainTables(pool: Pool): Promise<string[]> {
  const preserve = new Set(['cogeto_migrations', 'prompt_registry']);
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const targets = rows.map((r) => r.tablename).filter((t) => !preserve.has(t));
  if (targets.length > 0) {
    await pool.query(
      `TRUNCATE ${targets.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
  }
  // The Graphile queue lives in its own schema and is NOT truncated: the caller
  // drains to quiescence first (so nothing is pending), and when the scheduled
  // reset runs this from inside the worker, its own job row must survive so
  // Graphile can complete it. `job_execution` / `dead_letter` (public) are
  // included above and reset with the rest.
  return targets;
}
