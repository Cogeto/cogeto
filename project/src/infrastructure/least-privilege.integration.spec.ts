import * as path from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from './migrations';

/**
 * least_privilege (audit 2.0 SEC-1): proves the property the role split
 * exists for, against the REAL provisioning artifacts — the same db-init.sql
 * the compose one-shot mounts, executed by psql inside a real postgres:17
 * container, followed by the same applyMigrations() the migrate entrypoint
 * runs, connected as cogeto_migrate.
 *
 * The property: cogeto_app can do its job (DML, audit INSERT, add_job) and
 * can NOT disable the append-only trigger, drop the receipt ledger, truncate
 * the audit trail, create schema objects, or reach the zitadel database.
 */

const DB_INIT_SQL = path.resolve(
  __dirname,
  '..',
  '..',
  'infra',
  'docker',
  'postgres-init',
  'db-init.sql',
);

const APP_PASSWORD = 'app-test-password';
const MIGRATE_PASSWORD = 'migrate-test-password';

describe('least_privilege: the cogeto_app role cannot break the contracts it lives under', () => {
  let container: StartedPostgreSqlContainer;
  let appPool: Pool;
  let migratePool: Pool;

  const urlFor = (role: string, password: string, database: string): string =>
    `postgres://${role}:${password}@${container.getHost()}:${container.getMappedPort(5432)}/${database}`;

  beforeAll(async () => {
    // Mirror the compose stack exactly: superuser `postgres`, database `cogeto`.
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('cogeto')
      .withUsername('postgres')
      .withPassword('superuser-test-password')
      .withCopyFilesToContainer([{ source: DB_INIT_SQL, target: '/db-init.sql' }])
      .start();

    const psql = await container.exec([
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'cogeto',
      `--set=app_password=${APP_PASSWORD}`,
      `--set=migrate_password=${MIGRATE_PASSWORD}`,
      '--set=zitadel_admin_password=zitadel-admin-test-password',
      '--set=zitadel_password=zitadel-test-password',
      '-f',
      '/db-init.sql',
    ]);
    if (psql.exitCode !== 0) {
      throw new Error(`db-init.sql failed (${psql.exitCode}): ${psql.output}`);
    }

    // Migrations run as the schema owner — the migrate entrypoint's code path,
    // which also converges cogeto_app's grants (applyAppRoleGrants).
    migratePool = new Pool({
      connectionString: urlFor('cogeto_migrate', MIGRATE_PASSWORD, 'cogeto'),
    });
    migratePool.on('error', () => {});
    await applyMigrations(migratePool, path.resolve(__dirname, '..', 'migrations'));

    appPool = new Pool({ connectionString: urlFor('cogeto_app', APP_PASSWORD, 'cogeto') });
    appPool.on('error', () => {});
  });

  afterAll(async () => {
    await appPool?.end();
    await migratePool?.end();
    await container?.stop();
  });

  it('can do its job: DML, audit INSERT, transactional enqueue', async () => {
    await appPool.query(
      `INSERT INTO audit_log (actor, action, entity_type, entity_id) VALUES ('t', 'test', 'memory', 'x')`,
    );
    const audit = await appPool.query(`SELECT count(*)::int AS n FROM audit_log`);
    expect(audit.rows[0].n).toBe(1);

    // The transactional-outbox enqueue path (infrastructure/outbox.ts).
    await appPool.query(`SELECT graphile_worker.add_job('test_task', '{}'::json)`);
    const jobs = await appPool.query(`SELECT count(*)::int AS n FROM graphile_worker.jobs`);
    expect(jobs.rows[0].n).toBe(1);

    // A representative domain table (full DML granted).
    await appPool.query(`INSERT INTO note (owner_id, content) VALUES ('u', 'hello')`);
    await appPool.query(`DELETE FROM note`);
  });

  it('cannot disable the append-only audit trigger (not the table owner)', async () => {
    await expect(
      appPool.query(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_or_delete`),
    ).rejects.toThrow(/must be owner of table audit_log/);
  });

  it('cannot mutate or truncate the audit trail (no UPDATE/DELETE/TRUNCATE grant)', async () => {
    await expect(appPool.query(`UPDATE audit_log SET actor = 'x'`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(appPool.query(`DELETE FROM audit_log`)).rejects.toThrow(/permission denied/);
    // TRUNCATE would bypass the BEFORE-row trigger entirely — the grant is the
    // enforcement here, not the trigger.
    await expect(appPool.query(`TRUNCATE audit_log`)).rejects.toThrow(/permission denied/);
  });

  it('cannot drop or truncate the receipt ledger', async () => {
    await expect(appPool.query(`DROP TABLE deletion_receipt`)).rejects.toThrow(
      /must be owner of table deletion_receipt/,
    );
    await expect(appPool.query(`DELETE FROM deletion_receipt`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(appPool.query(`TRUNCATE deletion_receipt`)).rejects.toThrow(/permission denied/);
  });

  it('cannot connect to the zitadel database', async () => {
    const zitadelPool = new Pool({
      connectionString: urlFor('cogeto_app', APP_PASSWORD, 'zitadel'),
    });
    zitadelPool.on('error', () => {});
    try {
      await expect(zitadelPool.query('SELECT 1')).rejects.toThrow(/permission denied/);
    } finally {
      await zitadelPool.end();
    }
  });

  it('cannot create objects in the application schema (DDL stays with cogeto_migrate)', async () => {
    await expect(appPool.query(`CREATE TABLE sneaky (id int)`)).rejects.toThrow(
      /permission denied for schema public/,
    );
  });

  it('cannot write the migrations ledger (read-only for the runtime)', async () => {
    const ledger = await appPool.query(`SELECT count(*)::int AS n FROM cogeto_migrations`);
    expect(ledger.rows[0].n).toBeGreaterThan(0);
    await expect(
      appPool.query(`INSERT INTO cogeto_migrations (id, name) VALUES (9999, 'sneaky.sql')`),
    ).rejects.toThrow(/permission denied/);
  });

  it('the migrate role owns the schema and can run the next migration', async () => {
    // A DDL round-trip as cogeto_migrate — what the next real migration needs.
    await migratePool.query(`CREATE TABLE wave3_probe (id int)`);
    // Default privileges: the new table is immediately readable by cogeto_app.
    const probe = await appPool.query(`SELECT count(*)::int AS n FROM wave3_probe`);
    expect(probe.rows[0].n).toBe(0);
    await migratePool.query(`DROP TABLE wave3_probe`);
  });
});
