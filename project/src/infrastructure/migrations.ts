import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Pool } from 'pg';
import { runMigrations as runGraphileMigrations } from 'graphile-worker';

/**
 * Applies pending SQL migrations from project/src/migrations in filename order,
 * recording each in the cogeto_migrations ledger, and installs/updates the
 * Graphile Worker schema. Used by the migrate init container ( — never on
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

  // Least-privilege runtime grants (audit 2.0 SEC-1): converge the app role's
  // table-level rights after every migration run, so a new table is readable
  // the moment it exists and the append-only carve-outs are re-asserted.
  await applyAppRoleGrants(pool);

  return { applied, total: files.length };
}

/** The runtime role the app and worker connect as (SEC-1). */
export const APP_DB_ROLE = 'cogeto_app';

/**
 * Grants `cogeto_app` exactly the runtime surface the enumeration in the
 * SEC-1 remediation established, and nothing more:
 *
 *   - DML (+ TRUNCATE for the demo reset) on every application table;
 *   - audit_log: SELECT + INSERT only — no UPDATE/DELETE (the trigger raises
 *     anyway) and no TRUNCATE (which would BYPASS the BEFORE-row trigger);
 *   - deletion_receipt: no DELETE, no TRUNCATE (the freeze trigger allows
 *     updates only before confirmation, so UPDATE stays);
 *   - cogeto_migrations: read-only (health + capabilities read migration state);
 *   - graphile_worker.*: full DML + functions + sequences (the runner drives
 *     the _private_* tables directly; add_job is the transactional-outbox
 *     enqueue path; the boot-time migrate probe reads graphile_worker.migrations).
 *
 * Runs as the caller of applyMigrations — the migrate role, which owns every
 * object and may therefore GRANT/REVOKE on it. A no-op when the role does not
 * exist (bare local runs and test harnesses without the compose db-init step).
 */
export async function applyAppRoleGrants(pool: Pool, role: string = APP_DB_ROLE): Promise<boolean> {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`invalid app role name: ${role}`);
  const existing = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (existing.rowCount === 0) return false;

  const statements = [
    `GRANT USAGE ON SCHEMA public TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO ${role}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
    `REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM ${role}`,
    `REVOKE DELETE, TRUNCATE ON deletion_receipt FROM ${role}`,
    `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON cogeto_migrations FROM ${role}`,
    `GRANT USAGE ON SCHEMA graphile_worker TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA graphile_worker TO ${role}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA graphile_worker TO ${role}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA graphile_worker TO ${role}`,
    // Graphile Worker enables ROW LEVEL SECURITY on its private tables with no
    // policies — its model assumes the runtime IS the schema owner. We keep
    // ownership with the migrate role (so the runtime cannot DDL the queue)
    // and instead grant row access by policy. Recreated-on-upgrade tables lose
    // the policy, but this step re-runs after every migration.
    `DO $$
     DECLARE t text;
     BEGIN
       FOREACH t IN ARRAY ARRAY[
         '_private_jobs', '_private_job_queues', '_private_tasks', '_private_known_crontabs'
       ] LOOP
         IF to_regclass('graphile_worker.' || t) IS NOT NULL AND NOT EXISTS (
           SELECT FROM pg_policies
           WHERE schemaname = 'graphile_worker' AND tablename = t AND policyname = 'cogeto_app_rows'
         ) THEN
           EXECUTE format(
             'CREATE POLICY cogeto_app_rows ON graphile_worker.%I FOR ALL TO ${role} USING (true) WITH CHECK (true)',
             t
           );
         END IF;
       END LOOP;
     END $$`,
  ];
  for (const statement of statements) await pool.query(statement);
  return true;
}
