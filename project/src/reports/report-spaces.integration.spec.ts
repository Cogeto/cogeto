import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { ReportStore } from './report.store';
import { ReportSpaceCleanup } from './report-space-cleanup';
import type { FindingsReportRow } from './persistence/tables';

/**
 * The findings-report ledger is sealed per space (docs/features/spaces.md
 * section 6c, issue D): two spaces legitimately hold IDENTICAL scope keys
 * (every corpus scope canonicalizes the same), so the delta baseline, the
 * single-flight dedupe and the by-id reads must all carry the space, or a
 * first run in a new space would compute a delta against another partition's
 * run. Real Postgres; the ledger only, because that is where the seal lives.
 */

const OWNER = 'user-report-spaces';
const SPACE_A = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const SPACE_B = 'bbbbbbbb-0000-4000-8000-0000000000bb';
const CORPUS_KEY = '{"kind":"corpus"}';

describe('findings-report ledger per space (integration: real Postgres)', () => {
  let tdb: TestDatabase;
  let store: ReportStore;

  const createIn = async (spaceId: string): Promise<FindingsReportRow> =>
    tdb.db.transaction((tx) =>
      store.createInTx(tx, OWNER, 'org-r', { kind: 'corpus' }, CORPUS_KEY, 'en', spaceId),
    );
  const ready = async (row: FindingsReportRow): Promise<void> => {
    await store.recordArtifactKeys(row.id, `k/${row.id}.json`, `k/${row.id}.pdf`);
    await store.markReady(row.id, {
      jsonObjectKey: `k/${row.id}.json`,
      pdfObjectKey: `k/${row.id}.pdf`,
      jsonSizeBytes: 10,
      pdfSizeBytes: 10,
      payloadSha256: 'a'.repeat(64),
      signature: 'sig',
      modelConfigId: 'test-config',
      counts: {
        sourcesExamined: 1,
        sourcesUnreadable: 0,
        sourcesTruncated: 0,
        gateRefusals: 0,
        facts: 1,
        findingsOpen: 0,
        findingsResolved: 0,
        supersededFacts: 0,
        suppressedFacts: 0,
        resolvedSincePrevious: null,
        newSincePrevious: null,
        reopenedSincePrevious: null,
      },
      previousReportId: null,
      readyAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  };

  beforeAll(async () => {
    tdb = await startTestDatabase();
    for (const [id, name] of [
      [SPACE_A, 'Space A'],
      [SPACE_B, 'Space B'],
    ]) {
      await tdb.pool.query(`INSERT INTO space (id, name) VALUES ($1, $2)`, [id, name]);
    }
    store = new ReportStore(tdb.db);
  }, 120_000);

  afterAll(async () => {
    await tdb.stop();
  });

  it('the_delta_baseline_never_crosses_the_wall: identical corpus scope keys, per-space previous', async () => {
    const inA = await createIn(SPACE_A);
    await ready(inA);
    // A first run in space B, over the byte-identical scope key, finds NO
    // baseline: it says "first run" instead of computing a delta against
    // space A's counts.
    const inB = await createIn(SPACE_B);
    expect(await store.previousReady(OWNER, SPACE_B, CORPUS_KEY, inB.createdAt, inB.id)).toBeNull();
    // A second run in space A finds exactly space A's ready run.
    const secondA = await createIn(SPACE_A);
    const baseline = await store.previousReady(
      OWNER,
      SPACE_A,
      CORPUS_KEY,
      secondA.createdAt,
      secondA.id,
    );
    expect(baseline?.id).toBe(inA.id);
  });

  it('the_single_flight_dedupe_is_per_space: an in-flight run in one space never blocks another', async () => {
    // Both spaces hold an unfinished (pending) run from the previous test.
    const now = new Date();
    const unfinishedA = await store.unfinishedForOwner(tdb.db, OWNER, SPACE_A, now);
    const unfinishedB = await store.unfinishedForOwner(tdb.db, OWNER, SPACE_B, now);
    expect(unfinishedA).not.toBeNull();
    expect(unfinishedB).not.toBeNull();
    expect(unfinishedA!.spaceId).toBe(SPACE_A);
    expect(unfinishedB!.spaceId).toBe(SPACE_B);
    expect(unfinishedA!.id).not.toBe(unfinishedB!.id);
  });

  it('the_by_id_read_is_sealed: a run in another space reads as absent', async () => {
    const rows = await store.listForOwner(OWNER, SPACE_A);
    expect(rows.length).toBeGreaterThan(0);
    const id = rows[0]!.id;
    expect(await store.getForOwner(OWNER, id, SPACE_A)).not.toBeNull();
    expect(await store.getForOwner(OWNER, id, SPACE_B)).toBeNull();
    // Listings are one space's runs only.
    for (const row of rows) expect(row.spaceId).toBe(SPACE_A);
  });

  it('generated_reports_die_with_their_space: the cleanup leg removes the rows and returns the artifact keys', async () => {
    // A READY run in space B, so the leg has real artifact keys to return.
    const readyB = await createIn(SPACE_B);
    await ready(readyB);
    const cleanup = new ReportSpaceCleanup(tdb.db);
    const countB = await cleanup.countForSpace(SPACE_B);
    expect(countB).toBeGreaterThan(1);
    const { count, objectKeys } = await cleanup.cleanupSpace(SPACE_B);
    expect(count).toBe(countB);
    expect(await store.listForOwner(OWNER, SPACE_B)).toHaveLength(0);
    // Space A's runs and artifacts are untouched; B's artifact keys are
    // handed back for erasure with the rows.
    expect((await store.listForOwner(OWNER, SPACE_A)).length).toBeGreaterThan(0);
    expect(objectKeys).toContain(`k/${readyB.id}.json`);
    expect(objectKeys).toContain(`k/${readyB.id}.pdf`);
  });
});
