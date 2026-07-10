import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@cogeto/shared';
import { ensureInstanceKeys } from '../infrastructure/index';
import {
  fakeEmbedding,
  startTestDatabase,
  startTestMinio,
  startTestQdrant,
} from '../testing/index';
import type { TestDatabase, TestMinio, TestQdrant } from '../testing/index';
import { MemoryStore } from './memory.store';
import { MemoryFileStore } from './file-store';
import { MemoryVectorStore } from './persistence/vector-store';
import { MemoryObjectStore } from './persistence/object-store';
import { IntegritySweep } from './integrity-sweep';

const DIMS = 8;

const userA: Principal = {
  userId: 'sweep-arms-user',
  name: 'A',
  email: null,
  orgId: 'org-1',
  orgName: 'Org',
  roles: [],
};

describe('sweep arms QS-28 + QS-16 (integration: real Postgres + Qdrant + MinIO)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let minio: TestMinio;
  let keyDir: string;
  let vectors: MemoryVectorStore;
  let objects: MemoryObjectStore;
  let store: MemoryStore;
  let files: MemoryFileStore;

  beforeAll(async () => {
    [tdb, qdrant, minio] = await Promise.all([
      startTestDatabase(),
      startTestQdrant(),
      startTestMinio(),
    ]);
    keyDir = mkdtempSync(path.join(tmpdir(), 'cogeto-instance-keys-'));
    await ensureInstanceKeys(keyDir);
    vectors = new MemoryVectorStore({
      url: qdrant.url,
      embeddingModel: 'test-embed',
      dimensions: DIMS,
      collection: 'sweep-arms-test',
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
    files = new MemoryFileStore(tdb.db);
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop(), minio.stop()]);
  });

  const sweepWith = (graceMinutes: number) =>
    new IntegritySweep(tdb.db, vectors, objects, keyDir, [], {
      objectGraceMinutes: graceMinutes,
    });
  const alertsOf = async (kind: string): Promise<string[]> => {
    const { rows } = await tdb.pool.query<{ detail: string }>(
      `SELECT detail FROM integrity_alert WHERE kind = $1`,
      [kind],
    );
    return rows.map((r) => r.detail);
  };
  const clearAlerts = () => tdb.pool.query(`DELETE FROM integrity_alert`);

  it('orphan_object_arm: an object with no file_metadata row is flagged past the grace window; accounted and fresh objects are not (QS-28)', async () => {
    // Injection fixture: the exact residue a failed compensating delete leaves.
    const orphanKey = 'org-1/sweep-arms-user/private/file-orphan';
    await objects.putObject(orphanKey, Buffer.from('orphan bytes'));
    // A staging object that outlived its cleanup backstop.
    const staleStagingKey = 'org-1/sweep-arms-user/staging/file-stale';
    await objects.putObject(staleStagingKey, Buffer.from('stale staging bytes'));
    // A properly accounted upload: object + metadata row.
    const accountedKey = 'org-1/sweep-arms-user/private/file-accounted';
    await objects.putObject(accountedKey, Buffer.from('accounted bytes'));
    await tdb.db.transaction((tx) =>
      files.record(tx, {
        objectKey: accountedKey,
        ownerId: userA.userId,
        scope: 'private',
        sensitive: false,
        checksum: 'x',
        sizeBytes: 15,
      }),
    );

    // Inside the grace window nothing is an orphan — a stored upload's bytes
    // land before its metadata transaction commits, and staging objects live
    // legitimately until the cleanup backstop fires.
    const graceful = await sweepWith(60).run();
    expect(graceful.objectsScanned).toBeGreaterThanOrEqual(3);
    expect(await alertsOf('orphaned_object')).toHaveLength(0);

    // Past the window (grace 0 makes "past" immediate for the test): the
    // unaccounted object and the stale staging object alert; the accounted
    // upload does not.
    await sweepWith(0).run();
    const details = await alertsOf('orphaned_object');
    expect(details.some((d) => d.includes(orphanKey))).toBe(true);
    expect(details.some((d) => d.includes(staleStagingKey))).toBe(true);
    expect(details.some((d) => d.includes(accountedKey))).toBe(false);

    // Detection only: the bytes are still there — deleting is the saga's job.
    expect(await objects.objectExists(orphanKey)).toBe(true);

    await clearAlerts();
    await objects.deleteObject(orphanKey);
    await objects.deleteObject(staleStagingKey);
  });

  it('payload_mismatch_arm: a stale Qdrant payload is flagged AND self-healed by targeted re-upsert; a missing point is flagged for reindex (QS-16)', async () => {
    const row = await store.createFromFact(userA, {
      content: 'The renewal fee is agreed.',
      scope: 'private',
      sourceType: 'user_note',
      sourceId: `note-${Date.now()}`,
      embeddingModel: 'test-embed',
    });
    await store.upsertVectors([row], [fakeEmbedding(row.content ?? row.id, DIMS)]);

    // The QS-16 shape: the payload write landed, the row commit's state moved
    // on — Qdrant now claims 'shared' while Postgres says 'private'.
    await vectors.setPayload(row.id, { scope: 'shared', status: 'outdated' });

    // A second embedded row whose point vanished (index wipe / partial rebuild).
    const missing = await store.createFromFact(userA, {
      content: 'A fact whose point is gone.',
      scope: 'private',
      sourceType: 'user_note',
      sourceId: `note-${Date.now()}-b`,
      embeddingModel: 'test-embed',
    });

    const report = await sweepWith(60).run();
    expect(report.payloadsChecked).toBeGreaterThanOrEqual(2);
    expect(report.payloadsHealed).toBe(1);

    const details = await alertsOf('payload_mismatch');
    const staleAlert = details.find((d) => d.startsWith(row.id));
    expect(staleAlert).toBeDefined();
    // The alert copy states the honest severity: recall/consistency, not a leak.
    expect(staleAlert).toMatch(/not a leak/);
    expect(staleAlert).toMatch(/scope/);
    expect(details.find((d) => d.startsWith(missing.id))).toMatch(/point missing/);

    // Self-heal is real: the payload now mirrors the row's gate fields.
    const healed = (await vectors.retrievePayloads([row.id])).get(row.id)!;
    expect(healed['scope']).toBe('private');
    expect(healed['status']).toBe('active');
    expect(healed['sensitive']).toBe(false);

    // Idempotent: a re-run heals nothing further (the payload is now honest),
    // and the still-missing point's identical alert dedupes to zero new rows.
    const again = await sweepWith(60).run();
    expect(again.payloadsHealed).toBe(0);
    expect(again.newAlerts).toBe(0);

    await clearAlerts();
    await tdb.pool.query(`DELETE FROM memory WHERE id IN ($1, $2)`, [row.id, missing.id]);
    await vectors.deletePoints([row.id]);
  });
});
