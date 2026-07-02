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
