import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { PassportExportStore } from './passport.store';
import { PassportSpaceCleanup } from './passport-space-cleanup';

/**
 * The passport export ledger is sealed per space (docs/features/spaces.md
 * section 6c, issue D): an export covers ONE space (session 1's format 2.1),
 * so its status and download reads carry the caller's space, listings show
 * one space's exports only, and a generated export dies with the space it
 * describes through the cleanup leg, its object key handed back for erasure.
 * Real Postgres; the ledger only, since the archive's own per-space content
 * and standalone verification are the assembler's and the chain suite's
 * proofs (passport-assembler.spec.ts, memory/space-chains.integration.spec.ts).
 */

const OWNER = 'user-passport-spaces';
const SPACE_A = 'aaaaaaaa-0000-4000-8000-000000000a0a';
const SPACE_B = 'bbbbbbbb-0000-4000-8000-000000000b0b';

describe('passport export ledger per space (integration: real Postgres)', () => {
  let tdb: TestDatabase;
  let store: PassportExportStore;
  let exportA: string;
  let exportB: string;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    for (const [id, name] of [
      [SPACE_A, 'Space A'],
      [SPACE_B, 'Space B'],
    ]) {
      await tdb.pool.query(`INSERT INTO space (id, name) VALUES ($1, $2)`, [id, name]);
    }
    store = new PassportExportStore(tdb.db);
    const rowA = await tdb.db.transaction((tx) =>
      store.createInTx(tx, OWNER, 'org-p', false, SPACE_A),
    );
    const rowB = await tdb.db.transaction((tx) =>
      store.createInTx(tx, OWNER, 'org-p', false, SPACE_B),
    );
    exportA = rowA.id;
    exportB = rowB.id;
    await store.markReady(exportA, `org-p/${OWNER}/exports/passport-${exportA}.zip`, 100);
    await store.markReady(exportB, `org-p/${OWNER}/exports/passport-${exportB}.zip`, 100);
  }, 120_000);

  afterAll(async () => {
    await tdb.stop();
  });

  it('a_passport_from_one_space_is_invisible_from_another: by-id sealed, listings sealed', async () => {
    expect(await store.getForOwner(OWNER, exportA, SPACE_A)).not.toBeNull();
    expect(await store.getForOwner(OWNER, exportA, SPACE_B)).toBeNull();
    expect((await store.listForOwner(OWNER, SPACE_A)).map((r) => r.id)).toEqual([exportA]);
    expect((await store.listForOwner(OWNER, SPACE_B)).map((r) => r.id)).toEqual([exportB]);
  });

  it('a_generated_passport_dies_with_the_space_it_describes: the cleanup leg returns its object key', async () => {
    const cleanup = new PassportSpaceCleanup(tdb.db);
    expect(await cleanup.countForSpace(SPACE_B)).toBe(1);
    const { count, objectKeys } = await cleanup.cleanupSpace(SPACE_B);
    expect(count).toBe(1);
    expect(objectKeys).toEqual([`org-p/${OWNER}/exports/passport-${exportB}.zip`]);
    expect(await store.getForOwner(OWNER, exportB)).toBeNull();
    // The other space's export is untouched.
    expect(await store.getForOwner(OWNER, exportA, SPACE_A)).not.toBeNull();
  });
});
