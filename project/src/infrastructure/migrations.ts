import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Pool } from 'pg';
import { runMigrations as runGraphileMigrations } from 'graphile-worker';

/**
 * Applies pending SQL migrations from project/src/migrations in filename order,
 * recording each in the cogeto_migrations ledger, and installs/updates the
 * Graphile Worker schema. Used by the migrate init container (§A.2 — never on
 * app boot) and by the integration-test harness.
 */
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

export interface MigrationRunResult {
  applied: string[];
  total: number;
}

export async function applyMigrations(
  pool: Pool,
  migrationsDir: string = process.env.COGETO_MIGRATIONS_DIR ?? DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationRunResult> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cogeto_migrations (
      id          integer PRIMARY KEY,
      name        text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM cogeto_migrations');
  const alreadyApplied = new Set(rows.map((r) => r.name));

  const applied: string[] = [];
  for (const file of files) {
    if (alreadyApplied.has(file)) continue;
    const id = Number.parseInt(file.split('_')[0] ?? '', 10);
    if (Number.isNaN(id)) throw new Error(`migration filename must start with a number: ${file}`);

    const sqlText = await readFile(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sqlText);
      await client.query('INSERT INTO cogeto_migrations (id, name) VALUES ($1, $2)', [id, file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${String(error)}`, { cause: error });
    } finally {
      client.release();
    }
  }

  // Graphile Worker owns its own schema and migrations (graphile_worker.*).
  await runGraphileMigrations({ pgPool: pool });

  return { applied, total: files.length };
}
