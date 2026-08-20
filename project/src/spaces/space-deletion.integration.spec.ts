import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOnce } from 'graphile-worker';
import type { TaskList } from 'graphile-worker';
import { DEFAULT_SPACE_ID } from '@cogeto/shared';
import type { Principal } from '@cogeto/shared';
import {
  ensureInstanceKeys,
  idempotentTask,
  loadInstancePublicKey,
  InMemoryDailyCounters,
} from '../infrastructure/index';
import {
  fakeEmbedding,
  settleJobs,
  startTestDatabase,
  startTestMinio,
  startTestQdrant,
} from '../testing/index';
import type { TestDatabase, TestMinio, TestQdrant } from '../testing/index';
import { NotesService, NotesSourceDeletion } from '../notes/index';
import {
  DELETION_JOB_TYPE,
  DeletionExecutor,
  DeletionSaga,
  MemoryFileStore,
  MemoryObjectStore,
  MemoryStore,
  MemoryVectorStore,
  verifyChain,
} from '../memory/index';
import type { ConfirmedReceipt } from '../memory/index';
import { EntityAliasSpaceCleanup, EntityAliasStore } from '../ingestion/index';
import { ProjectSpaceCleanup } from '../projects/index';
import { AgentsSpaceCleanup } from '../agents/index';
import { SpaceService } from './space.service';
import { SpaceErasureService } from './space-erasure.service';
import { space } from './persistence/tables';

/**
 * Space deletion (docs/features/spaces.md section 5, session 2): the ordinary
 * saga per source, one receipt each, then the container cleanups, then the
 * space row — verified by ENUMERATION across every store rather than by
 * assumption, with the final row delete doubling as the schema-level
 * completeness proof (every content table's space FK is NO ACTION).
 */

const DIMS = 8;

describe('space deletion (integration: real Postgres + Qdrant + MinIO)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let minio: TestMinio;
  let keyDir: string;
  let vectors: MemoryVectorStore;
  let objects: MemoryObjectStore;
  let store: MemoryStore;
  let notes: NotesService;
  let saga: DeletionSaga;
  let executor: DeletionExecutor;
  let erasure: SpaceErasureService;
  let spaces: SpaceService;
  let doomed: string;

  beforeAll(async () => {
    [tdb, qdrant, minio] = await Promise.all([
      startTestDatabase(),
      startTestQdrant(),
      startTestMinio(),
    ]);
    keyDir = mkdtempSync(path.join(tmpdir(), 'cogeto-space-keys-'));
    await ensureInstanceKeys(keyDir);
    vectors = new MemoryVectorStore({
      url: qdrant.url,
      embeddingModel: 'test-embed',
      dimensions: DIMS,
      collection: 'space-deletion-test',
    });
    await vectors.ensureCollection();
    objects = new MemoryObjectStore({
      url: minio.url,
      accessKey: minio.accessKey,
      secretKey: minio.secretKey,
      bucket: 'cogeto',
    });
    await objects.ensureBucket();
    store = new MemoryStore(tdb.db, vectors);
    notes = new NotesService(tdb.db, new InMemoryDailyCounters(), {
      captureMax: 1_000_000,
      uploadMax: 1_000_000,
    });
    const adapters = [new NotesSourceDeletion()];
    saga = new DeletionSaga(tdb.db, { adapters, vectors });
    executor = new DeletionExecutor(vectors, objects, keyDir);
    erasure = new SpaceErasureService(tdb.db, saga, objects, adapters, [
      new ProjectSpaceCleanup(tdb.db),
      new EntityAliasSpaceCleanup(tdb.db),
      new AgentsSpaceCleanup(tdb.db),
    ]);
    spaces = new SpaceService(tdb.db);
    const [row] = await tdb.db.insert(space).values({ name: 'Doomed' }).returning();
    doomed = row!.id;
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop(), minio.stop()]);
  });

  const principalFor = (userId: string, spaceId?: string): Principal => ({
    userId,
    name: 'Deleter',
    email: null,
    orgId: 'org-del',
    orgName: 'Org',
    roles: ['cogeto-admin'],
    spaceId,
  });

  const pumpDeletions = async () => {
    const tasks: TaskList = {
      [DELETION_JOB_TYPE]: idempotentTask(tdb.db, DELETION_JOB_TYPE, async (tx, payload) => {
        await executor.execute(tx, payload.source_id);
      }),
    };
    await runOnce({ pgPool: tdb.pool, taskList: tasks });
    await settleJobs(tdb.pool);
    await runOnce({ pgPool: tdb.pool, taskList: tasks });
  };

  const confirmedIn = async (spaceId: string): Promise<ConfirmedReceipt[]> => {
    const { rows } = await tdb.pool.query(
      "SELECT * FROM deletion_receipt WHERE status = 'confirmed' AND space_id = $1",
      [spaceId],
    );
    return (rows as Record<string, never>[]).map((row) => ({
      id: row['id'] as string,
      source_type: row['source_type'] as string,
      source_id: row['source_id'] as string,
      counts_json: row['counts_json'],
      signed_at: (row['signed_at'] as Date).toISOString(),
      confirmed_at: (row['confirmed_at'] as Date).toISOString(),
      prev_hash: row['prev_hash'] as string,
      hash: row['hash'] as string,
      signature: row['signature'] as string,
    }));
  };

  const countWhere = async (sql: string, params: unknown[]): Promise<number> => {
    const { rows } = await tdb.pool.query<{ n: string }>(sql, params);
    return Number(rows[0]?.n ?? 0);
  };

  it('default_space_is_never_deletable: the resolution anchor refuses, always', async () => {
    await expect(erasure.plan(DEFAULT_SPACE_ID)).rejects.toThrow(/default space/);
    await expect(erasure.request(principalFor('admin-1'), DEFAULT_SPACE_ID)).rejects.toThrow(
      /default space/,
    );
    await expect(erasure.run(DEFAULT_SPACE_ID, 'user:admin-1', 'org-del')).rejects.toThrow(
      /default space/,
    );
  });

  it('deleting_a_space_leaves_nothing_in_any_store: one receipt per source, per-space chain verifying, every table, vector and object clean, the row gone, last-used degrading to the default', async () => {
    const alice = principalFor('space-del-alice', doomed);
    const bob = principalFor('space-del-bob', doomed);

    // Two owners' notes with facts and vectors — the saga must act per
    // source FOR its own owner, so a space is never one person's erasure.
    const noteA = await notes.createNote(alice, 'The kiln firing schedule is nightly.');
    const noteB = await notes.createNote(bob, 'The kiln temperature ceiling is 1260 C.');
    const factA = await store.createFromFact(alice, {
      content: 'The kiln firing schedule is nightly.',
      scope: 'private',
      sourceType: 'user_note',
      sourceId: noteA.id,
    });
    // SHARED material dies with its space too: scope governs visibility
    // within a space, never survival across the space's own deletion.
    const factB = await store.createFromFact(bob, {
      content: 'The kiln temperature ceiling is 1260 C.',
      scope: 'shared',
      sourceType: 'user_note',
      sourceId: noteB.id,
    });
    await store.upsertVectors(
      [factA, factB],
      [fakeEmbedding(factA.id, DIMS), fakeEmbedding(factB.id, DIMS)],
    );

    // A stored file source: metadata row + real bytes in the object store.
    const fileKey = `org-del/${alice.userId}/private/file-${randomUUID()}`;
    await objects.putObject(fileKey, Buffer.from('space-doomed bytes'), 'text/plain', {});
    const files = new MemoryFileStore(tdb.db);
    await tdb.db.transaction((tx) =>
      files.record(tx, {
        objectKey: fileKey,
        ownerId: alice.userId,
        scope: 'private',
        sensitive: false,
        spaceId: doomed,
        checksum: `sha-${randomUUID()}`,
        sizeBytes: 18,
      }),
    );
    const fileFact = await store.createFromFact(alice, {
      content: 'The kiln manual names a 90 minute soak.',
      scope: 'private',
      sourceType: 'file',
      sourceId: fileKey,
    });
    await store.upsertVectors([fileFact], [fakeEmbedding(fileFact.id, DIMS)]);

    // A DISCARD-mode file source (verification F1's sibling, found by the
    // wall-holes hand walk): no file_metadata row and no bytes by design,
    // only derived memories carrying the key as provenance. Without the
    // provenance-enumeration net this space could never finish deleting.
    const discardKey = `org-del/${alice.userId}/private/file-${randomUUID()}`;
    const discardFact = await store.createFromFact(alice, {
      content: 'The discarded memo names a spare thermocouple in cabinet 7.',
      scope: 'private',
      sourceType: 'file',
      sourceId: discardKey,
    });
    await store.upsertVectors([discardFact], [fakeEmbedding(discardFact.id, DIMS)]);

    // Containers: an alias and a project in the doomed space (raw seed rows;
    // the cleanups under test remove them through their owning classes).
    await new EntityAliasStore(tdb.db).add(alice.userId, 'Kiln One', 'Pec broj jedan', doomed);
    await tdb.pool.query(`INSERT INTO project (owner_id, space_id, name) VALUES ($1, $2, $3)`, [
      alice.userId,
      doomed,
      'Kiln overhaul',
    ]);
    // An approval raised in the doomed space (spaces verification F1): the
    // table's NO ACTION space FK made a space with any approval row
    // permanently undeletable until the agents cleanup leg existed, and this
    // seed is what keeps that leg mandatory.
    await tdb.pool.query(
      `INSERT INTO approval (action_type, payload_json, status, org_id, requested_by, space_id)
       VALUES ('bulk_outdate', '{"memoryIds":["00000000-0000-4000-8000-00000000dead"]}', 'pending_approval', $1, $2, $3)`,
      ['org-del', alice.userId, doomed],
    );
    // The space is someone's persisted last-used space.
    await spaces.setCurrent(alice, doomed);
    expect(await spaces.currentFor(alice)).toBe(doomed);

    // The plan states exactly what will be erased.
    const plan = await erasure.plan(doomed);
    expect(plan.totalSources).toBe(4);
    expect(plan.sources).toEqual(
      expect.arrayContaining([
        { sourceType: 'user_note', count: 2 },
        // The stored file AND the discard-mode one: the plan counts what the
        // pass will actually erase, discarded provenance included.
        { sourceType: 'file', count: 2 },
      ]),
    );
    expect(plan.containers).toEqual(
      expect.arrayContaining([
        { artifact: 'projects', count: 1 },
        { artifact: 'entity_aliases', count: 1 },
        { artifact: 'approvals', count: 1 },
      ]),
    );

    // The pass: one ordinary saga per source, then cleanups, then the row.
    const result = await erasure.run(doomed, 'user:space-admin', 'org-del');
    expect(result.failed).toEqual([]);
    expect(result.erased).toHaveLength(4);
    expect(result.erased.every((entry) => entry.receiptId !== null)).toBe(true);
    expect(result.containersRemoved).toMatchObject({
      projects: 1,
      entity_aliases: 1,
      approvals: 1,
    });
    expect(result.spaceRowDeleted).toBe(true);

    // The worker leg confirms each receipt; the DELETED space's chain
    // verifies standalone, from the receipts, with no space row anywhere.
    await pumpDeletions();
    const receipts = await confirmedIn(doomed);
    expect(receipts).toHaveLength(4);
    const publicKey = await loadInstancePublicKey(keyDir);
    expect(verifyChain(receipts, publicKey)).toEqual({ ok: true, verified: 4, confirmed: 4 });

    // Nothing left in ANY store, by enumeration, not assumption.
    expect(await countWhere('SELECT count(*) AS n FROM memory WHERE space_id = $1', [doomed])).toBe(
      0,
    );
    expect(await countWhere('SELECT count(*) AS n FROM note WHERE space_id = $1', [doomed])).toBe(
      0,
    );
    expect(
      await countWhere('SELECT count(*) AS n FROM file_metadata WHERE space_id = $1', [doomed]),
    ).toBe(0);
    expect(
      await countWhere('SELECT count(*) AS n FROM project WHERE space_id = $1', [doomed]),
    ).toBe(0);
    expect(
      await countWhere('SELECT count(*) AS n FROM entity_alias WHERE space_id = $1', [doomed]),
    ).toBe(0);
    expect(
      await countWhere('SELECT count(*) AS n FROM approval WHERE space_id = $1', [doomed]),
    ).toBe(0);
    expect(await objects.statObject(fileKey)).toBeNull();
    const vectorHits = await store.vectorSearch(
      principalFor(alice.userId, doomed),
      fakeEmbedding(factA.id, DIMS),
      { topK: 10 },
    );
    expect(vectorHits).toHaveLength(0);
    // The space row itself is gone and the list no longer names it.
    expect((await spaces.list()).some((row) => row.id === doomed)).toBe(false);
    // The persisted last-used pointer degrades to the default space.
    expect(await spaces.currentFor(alice)).toBe(DEFAULT_SPACE_ID);
    // The default space and its (empty) state are untouched.
    expect((await spaces.list()).some((row) => row.id === DEFAULT_SPACE_ID)).toBe(true);
    // A re-run is a clean no-op: done is done.
    const again = await erasure.run(doomed, 'user:space-admin', 'org-del');
    expect(again.erased).toHaveLength(0);
    expect(again.spaceRowDeleted).toBe(true);
  });
});
