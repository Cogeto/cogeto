import * as path from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { applyMigrations, createDb } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';

/**
 * Integration-test database: a real postgres:17 container with the full
 * migration set (0001, 0002, graphile_worker) applied — the same code path
 * the migrate init container runs.
 */
export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  pool: Pool;
  db: Db;
  stop(): Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  // graphile-worker 0.17 no longer installs a default pool error handler; a
  // bare pool would crash the test process on an idle-client error.
  pool.on('error', (error) => {
    console.error('test pg pool idle client error:', error);
  });
  await applyMigrations(pool, path.resolve(__dirname, '..', 'migrations'));
  const db = createDb(pool);
  return {
    container,
    pool,
    db,
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}

/**
 * Wait until graphile-worker has committed all job bookkeeping: no job row
 * still holds a lock. Since 0.17, a failed attempt's write (attempts++,
 * lock release, backoff `run_at`) can land AFTER `runOnce` resolves — a test
 * that immediately pulls `run_at` forward races it and the late write pushes
 * the job back into the future, so the next `runOnce` finds nothing. Call
 * this before reading job rows or rescheduling retries.
 */
export async function settleJobs(pool: Pool, timeoutMs = 5000): Promise<void> {
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
