import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Pool } from 'pg';
import { runMigrations as runGraphileMigrations } from 'graphile-worker';

/**
 * Applies pending SQL migrations from project/src/migrations in filename order,
 * recording each in the cogeto_migrations ledger, and installs/updates the
 * Graphile Worker schema. Used by the migrate init container ( — never on
 * app boot) and by the integration-test harness.
 *
 * Security audit 2.0 SEC-25 added two integrity properties the runner lacked:
 *
 *  1. an ADVISORY LOCK around the whole run, so two concurrent `migrate` jobs
 *     (a restart racing an upgrade, two operators, a compose re-run) serialize
 *     instead of both reading "nothing applied yet" and both executing;
 *  2. a CHECKSUM per applied migration, so editing a migration that has already
 *     run is DETECTED. Migrations are immutable by contract, and an edited one
 *     silently gives two instances different schemas from the same version.
 */
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

/**
 * The advisory-lock key for the migration runner. A fixed 64-bit constant, not
 * a hash of anything: there is exactly one migration lock per database.
 */
const MIGRATION_LOCK_KEY = 8_675_309_042_026n;

export interface MigrationRunResult {
  applied: string[];
  total: number;
}

/** sha256 of a migration file's bytes, hex — the ledger's integrity column. */
export function migrationChecksum(sqlText: string): string {
  return createHash('sha256').update(sqlText, 'utf8').digest('hex');
}

export async function applyMigrations(
  pool: Pool,
  // Blank means unset: compose passes every documented knob as `${VAR:-}`,
  // so an operator who set nothing delivers an empty string (issue #516).
  migrationsDir: string = process.env.COGETO_MIGRATIONS_DIR || DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationRunResult> {
  // SEC-25: hold the lock on ONE dedicated connection for the whole run. A
  // session-level lock (not xact-level) is required because the run spans many
  // transactions; the finally block releases it, and a crashed process releases
  // it when its backend disconnects.
  const lockHolder = await pool.connect();
  try {
    await lockHolder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
    return await runMigrationsUnderLock(pool, migrationsDir);
  } finally {
    try {
      await lockHolder.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()]);
    } finally {
      lockHolder.release();
    }
  }
}

async function runMigrationsUnderLock(
  pool: Pool,
  migrationsDir: string,
): Promise<MigrationRunResult> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cogeto_migrations (
      id          integer PRIMARY KEY,
      name        text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
  // Additive and idempotent: the ledger predates this column, so instances
  // upgrading into SEC-25 grow it here rather than in a numbered migration
  // (the runner must be able to read its own ledger before running anything).
  await pool.query('ALTER TABLE cogeto_migrations ADD COLUMN IF NOT EXISTS checksum text');

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ name: string; checksum: string | null }>(
    'SELECT name, checksum FROM cogeto_migrations',
  );
  const alreadyApplied = new Map(rows.map((r) => [r.name, r.checksum]));

  // SEC-25: verify every applied migration still hashes to what was recorded,
  // BEFORE running anything new — a diverged instance must fail loudly, not
  // quietly stack a new migration on top of a schema that is not what the
  // ledger claims.
  await verifyAppliedChecksums(pool, alreadyApplied, files, migrationsDir);

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
      await client.query('INSERT INTO cogeto_migrations (id, name, checksum) VALUES ($1, $2, $3)', [
        id,
        file,
        migrationChecksum(sqlText),
      ]);
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

/**
 * SEC-25 checksum verification.
 *
 *  - recorded checksum differs from the file's → REFUSE. An applied migration
 *    was edited; this instance's schema and the repository no longer agree, and
 *    every other instance on the same version got something different.
 *  - recorded checksum is NULL (applied before this ledger column existed) →
 *    adopt the current file's hash. This is the only possible adoption path: we
 *    cannot know what the file looked like when it ran. It is stated plainly
 *    rather than presented as verification, and it locks the file from then on.
 *  - the file is gone entirely → refuse. A deleted applied migration is the
 *    same divergence wearing a different hat.
 */
async function verifyAppliedChecksums(
  pool: Pool,
  alreadyApplied: Map<string, string | null>,
  files: string[],
  migrationsDir: string,
): Promise<void> {
  const present = new Set(files);
  const drift: string[] = [];
  const adopted: [string, string][] = [];

  for (const [name, recorded] of alreadyApplied) {
    if (!present.has(name)) {
      drift.push(
        `${name}: applied on this instance but no longer present in the migrations directory`,
      );
      continue;
    }
    const actual = migrationChecksum(await readFile(path.join(migrationsDir, name), 'utf8'));
    if (recorded === null) {
      adopted.push([name, actual]);
    } else if (recorded !== actual) {
      drift.push(
        `${name}: recorded sha256 ${recorded.slice(0, 12)}, file is now ${actual.slice(0, 12)}`,
      );
    }
  }

  if (drift.length > 0) {
    throw new Error(
      'migration integrity check failed (audit 2.0 SEC-25): an already-applied migration ' +
        'changed. Migrations are immutable once applied: restore the original file and add a ' +
        'NEW migration for the change, or (if this instance is knowingly diverged) reconcile ' +
        `cogeto_migrations by hand. Drift:\n  ${drift.join('\n  ')}`,
    );
  }

  for (const [name, checksum] of adopted) {
    await pool.query(
      'UPDATE cogeto_migrations SET checksum = $2 WHERE name = $1 AND checksum IS NULL',
      [name, checksum],
    );
  }
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
