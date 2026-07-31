import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { applyMigrations, migrationChecksum } from './migrations';

/**
 * Migration-runner integrity (security audit 2.0 SEC-25).
 *
 * The runner took no lock and recorded no checksum, so two concurrent
 * `migrate` runs could both read "nothing applied yet" and both execute, and an
 * edited already-applied migration diverged instances silently from the same
 * released version.
 *
 * This suite runs against a bare container rather than the shared test harness,
 * because the harness applies the REAL migrations on startup and these cases
 * need a database whose ledger they control completely.
 */
describe('migration runner integrity (integration, real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let url: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    url = container.getConnectionUri();
  }, 120_000);
  afterAll(async () => {
    await container.stop();
  });

  /** A throwaway migrations directory with the given files. */
  const dirWith = async (files: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cogeto-migrations-'));
    for (const [name, sql] of Object.entries(files)) {
      await writeFile(path.join(dir, name), sql, 'utf8');
    }
    return dir;
  };

  /** A fresh, empty database on the shared container. */
  const freshDatabase = async (name: string): Promise<Pool> => {
    const admin = new Pool({ connectionString: url });
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    return new Pool({ connectionString: url.replace(/\/[^/]+$/, `/${name}`) });
  };

  it('records a checksum for every migration it applies', async () => {
    const pool = await freshDatabase('sec25_records');
    const sql = 'CREATE TABLE widget (id integer PRIMARY KEY);';
    const dir = await dirWith({ '0001_widget.sql': sql });
    try {
      const result = await applyMigrations(pool, dir);
      expect(result.applied).toEqual(['0001_widget.sql']);
      const { rows } = await pool.query<{ name: string; checksum: string }>(
        'SELECT name, checksum FROM cogeto_migrations',
      );
      expect(rows).toEqual([{ name: '0001_widget.sql', checksum: migrationChecksum(sql) }]);
    } finally {
      await pool.end();
    }
  });

  it('refuses to run when an ALREADY-APPLIED migration was edited', async () => {
    const pool = await freshDatabase('sec25_edited');
    try {
      const original = await dirWith({ '0001_widget.sql': 'CREATE TABLE widget (id integer);' });
      await applyMigrations(pool, original);

      // The same version number, different content — exactly the case that
      // used to give two instances different schemas from one release.
      const edited = await dirWith({
        '0001_widget.sql': 'CREATE TABLE widget (id integer, sneaky text);',
        '0002_next.sql': 'CREATE TABLE gadget (id integer);',
      });
      await expect(applyMigrations(pool, edited)).rejects.toThrow(
        /migration integrity check failed/i,
      );
      // And it refused BEFORE running the new migration: no partial state.
      const { rows } = await pool.query('SELECT to_regclass($1) AS present', ['public.gadget']);
      expect((rows[0] as { present: string | null }).present).toBeNull();
    } finally {
      await pool.end();
    }
  });

  it('refuses when an applied migration file has been deleted', async () => {
    const pool = await freshDatabase('sec25_deleted');
    try {
      await applyMigrations(pool, await dirWith({ '0001_a.sql': 'CREATE TABLE a (id integer);' }));
      const without = await dirWith({ '0002_b.sql': 'CREATE TABLE b (id integer);' });
      await expect(applyMigrations(pool, without)).rejects.toThrow(/no longer present/i);
    } finally {
      await pool.end();
    }
  });

  it('adopts a NULL checksum once (the pre-SEC-25 ledger) and locks the file from then on', async () => {
    const pool = await freshDatabase('sec25_adopt');
    const sql = 'CREATE TABLE legacy (id integer);';
    const dir = await dirWith({ '0001_legacy.sql': sql });
    try {
      await applyMigrations(pool, dir);
      // Simulate an instance that applied this before the column existed.
      await pool.query('UPDATE cogeto_migrations SET checksum = NULL');
      await applyMigrations(pool, dir); // adopts, does not fail
      const { rows } = await pool.query<{ checksum: string }>(
        'SELECT checksum FROM cogeto_migrations',
      );
      expect(rows[0]!.checksum).toBe(migrationChecksum(sql));

      // From here the file is locked: editing it is detected.
      const edited = await dirWith({ '0001_legacy.sql': `${sql}\n-- changed` });
      await expect(applyMigrations(pool, edited)).rejects.toThrow(/integrity check failed/i);
    } finally {
      await pool.end();
    }
  });

  it('serializes concurrent runs: two racing migrate jobs apply each migration exactly once', async () => {
    // Without the advisory lock both runs read an empty ledger, both execute
    // the same CREATE TABLE, and the loser fails on "relation already exists"
    // — a migrate init container that exits non-zero and blocks the stack.
    const pool = await freshDatabase('sec25_race');
    const other = new Pool({ connectionString: url.replace(/\/[^/]+$/, '/sec25_race') });
    const dir = await dirWith({
      '0001_a.sql': 'CREATE TABLE a (id integer PRIMARY KEY);',
      '0002_b.sql': 'CREATE TABLE b (id integer PRIMARY KEY);',
    });
    try {
      const [first, second] = await Promise.all([
        applyMigrations(pool, dir),
        applyMigrations(other, dir),
      ]);
      // Both runs succeed, and between them each migration ran exactly once.
      const appliedByBoth = [...first.applied, ...second.applied].sort();
      expect(appliedByBoth).toEqual(['0001_a.sql', '0002_b.sql']);
      const { rows } = await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM cogeto_migrations',
      );
      expect(Number(rows[0]!.n)).toBe(2);
    } finally {
      await Promise.all([pool.end(), other.end()]);
    }
  }, 60_000);
});
