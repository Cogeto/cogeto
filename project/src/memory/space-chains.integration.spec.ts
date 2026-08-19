import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOnce } from 'graphile-worker';
import type { TaskList } from 'graphile-worker';
import type { Principal } from '@cogeto/shared';
import {
  ensureInstanceKeys,
  idempotentTask,
  loadInstancePublicKey,
  loadInstanceSigner,
} from '../infrastructure/index';
import {
  fakeEmbedding,
  startTestDatabase,
  startTestMinio,
  startTestQdrant,
} from '../testing/index';
import type { TestDatabase, TestMinio, TestQdrant } from '../testing/index';
import { DELETION_JOB_TYPE, DeletionExecutor, DeletionSaga } from './deletion-saga';
import { canonicalize, GENESIS_HASH, verifyChain } from './domain/receipt-chain';
import type { ConfirmedReceipt } from './domain/receipt-chain';
import { MemoryStore } from './memory.store';
import { MemoryVectorStore } from './persistence/vector-store';
import { MemoryObjectStore } from './persistence/object-store';
import type { MemoryRow } from './persistence/tables';
import { NotesSourceDeletion } from '../notes/index';

const DIMS = 8;

/**
 * Per-space receipt chains (docs/features/spaces.md section 5 as amended,
 * issue: per-space receipt chains). Two spaces produce two INDEPENDENT
 * verifiable chains under the one frozen genesis constant; tampering in one
 * leaves the other verifying; a receipt written in the pre-spaces shape (no
 * space named, the schema default) verifies unchanged as the default space's
 * chain; and no receipt ever references a receipt from another space.
 */
describe('per-space receipt chains (integration: real Postgres + Qdrant + MinIO)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let minio: TestMinio;
  let keyDir: string;
  let store: MemoryStore;
  let saga: DeletionSaga;
  let executor: DeletionExecutor;
  let publicKey: string;

  const SPACE_B = randomUUID();
  const user: Principal = {
    userId: 'user-chain',
    name: 'User',
    email: null,
    orgId: 'org-1',
    orgName: 'Org',
    roles: [],
  };
  const userInB: Principal = { ...user, spaceId: SPACE_B };
  /** A pre-spaces receipt seeded in the legacy column shape. */
  const legacyReceiptId = randomUUID();

  beforeAll(async () => {
    [tdb, qdrant, minio] = await Promise.all([
      startTestDatabase(),
      startTestQdrant(),
      startTestMinio(),
    ]);
    keyDir = mkdtempSync(path.join(tmpdir(), 'cogeto-space-chain-keys-'));
    await ensureInstanceKeys(keyDir);
    publicKey = await loadInstancePublicKey(keyDir);

    const vectors = new MemoryVectorStore({
      url: qdrant.url,
      embeddingModel: 'test-embed',
      dimensions: DIMS,
      collection: 'space-chain-test',
    });
    await vectors.ensureCollection();
    const objects = new MemoryObjectStore({
      url: minio.url,
      accessKey: minio.accessKey,
      secretKey: minio.secretKey,
      bucket: 'cogeto',
    });
    await objects.ensureBucket();

    store = new MemoryStore(tdb.db, vectors);
    saga = new DeletionSaga(tdb.db, { adapters: [new NotesSourceDeletion()] });
    executor = new DeletionExecutor(vectors, objects, keyDir);

    await tdb.pool.query('INSERT INTO space (id, name) VALUES ($1, $2)', [SPACE_B, 'Sealed B']);

    // A receipt in the shape every receipt had BEFORE the migration: the
    // INSERT names no space column at all, hand-hashed and signed exactly as
    // the executor would have. It must land in the default space's chain and
    // verify byte-identically after the migration added the column.
    const signer = await loadInstanceSigner(keyDir);
    const iso = new Date().toISOString();
    const counts = {
      source: { type: 'user_note', id: 'legacy-note' },
      requested_by: user.userId,
      memory_ids: [],
      memory_count: 0,
      chat_messages_redacted: 0,
      reply_drafts_redacted: 0,
      point_ids: [],
      object_keys: [],
      superseded_by_nulled: [],
      enumerated_at: iso,
    };
    const legacyHash = createHash('sha256')
      .update(
        Buffer.from(
          canonicalize({
            id: legacyReceiptId,
            source_type: 'user_note',
            source_id: 'legacy-note',
            counts_json: counts,
            signed_at: iso,
            confirmed_at: iso,
            prev_hash: GENESIS_HASH,
          }),
          'utf8',
        ),
      )
      .digest('hex');
    await tdb.pool.query(
      `INSERT INTO deletion_receipt
         (id, source_type, source_id, counts_json, status, prev_hash, hash, signature, signed_at, confirmed_at)
       VALUES ($1, 'user_note', 'legacy-note', $2, 'confirmed', $3, $4, $5, $6, $6)`,
      [
        legacyReceiptId,
        JSON.stringify(counts),
        GENESIS_HASH,
        legacyHash,
        signer.sign(legacyHash),
        iso,
      ],
    );
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop(), minio.stop()]);
  });

  const tasks: () => TaskList = () => ({
    [DELETION_JOB_TYPE]: idempotentTask(tdb.db, DELETION_JOB_TYPE, async (tx, payload) => {
      await executor.execute(tx, payload.source_id as string);
    }),
  });
  const runWorker = () => runOnce({ pgPool: tdb.pool, taskList: tasks() });

  const factIn = async (principal: Principal): Promise<MemoryRow> => {
    const row = await store.createFromFact(principal, {
      content: `fact ${randomUUID()}`,
      scope: 'private',
      sourceType: 'user_note',
      sourceId: randomUUID(),
    });
    await store.upsertVectors([row], [fakeEmbedding(row.content ?? row.id, DIMS)]);
    return row;
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
  const defaultSpaceId = async (): Promise<string> => {
    const { rows } = await tdb.pool.query<{ space_id: string }>(
      'SELECT space_id FROM deletion_receipt WHERE id = $1',
      [legacyReceiptId],
    );
    return rows[0]!.space_id;
  };

  it('two_spaces_two_independent_chains: three deletions each, both verify standalone, no cross reference', async () => {
    for (let i = 0; i < 3; i += 1) {
      const inDefault = await factIn(user);
      const inB = await factIn(userInB);
      expect(
        (await saga.requestSourceDeletion(user, 'user_note', inDefault.sourceId)).receiptId,
      ).toBeTruthy();
      expect(
        (await saga.requestSourceDeletion(userInB, 'user_note', inB.sourceId)).receiptId,
      ).toBeTruthy();
    }
    await runWorker();

    const defaultSpace = await defaultSpaceId();
    const chainA = await confirmedIn(defaultSpace);
    const chainB = await confirmedIn(SPACE_B);
    // Default space: the legacy pre-spaces receipt plus three new ones,
    // verifying as ONE chain, which is the "existing chain becomes the
    // default space's chain unchanged" promise made concrete.
    expect(chainA).toHaveLength(4);
    expect(verifyChain(chainA, publicKey)).toEqual({ ok: true, verified: 4, confirmed: 4 });
    // Space B: its own genesis, its own sequence, its own tip.
    expect(chainB).toHaveLength(3);
    expect(verifyChain(chainB, publicKey)).toEqual({ ok: true, verified: 3, confirmed: 3 });
    expect(chainB.filter((r) => r.prev_hash === GENESIS_HASH)).toHaveLength(1);

    // A receipt never references a receipt from another space: every
    // prev_hash is the genesis constant or a hash within its own space.
    const hashesA = new Set(chainA.map((r) => r.hash));
    const hashesB = new Set(chainB.map((r) => r.hash));
    for (const receipt of chainA) {
      expect(hashesB.has(receipt.prev_hash)).toBe(false);
      expect(receipt.prev_hash === GENESIS_HASH || hashesA.has(receipt.prev_hash)).toBe(true);
    }
    for (const receipt of chainB) {
      expect(hashesA.has(receipt.prev_hash)).toBe(false);
      expect(receipt.prev_hash === GENESIS_HASH || hashesB.has(receipt.prev_hash)).toBe(true);
    }
  });

  it('tampering_in_one_space_leaves_the_other_verifying', async () => {
    const defaultSpace = await defaultSpaceId();
    const victim = (await confirmedIn(SPACE_B))[0]!;
    await tdb.pool.query(
      'ALTER TABLE deletion_receipt DISABLE TRIGGER deletion_receipt_freeze_trigger',
    );
    await tdb.pool.query(
      `UPDATE deletion_receipt SET counts_json = jsonb_set(counts_json, '{memory_count}', '999') WHERE id = $1`,
      [victim.id],
    );
    await tdb.pool.query(
      'ALTER TABLE deletion_receipt ENABLE TRIGGER deletion_receipt_freeze_trigger',
    );
    try {
      expect(verifyChain(await confirmedIn(SPACE_B), publicKey).ok).toBe(false);
      expect(verifyChain(await confirmedIn(defaultSpace), publicKey).ok).toBe(true);
    } finally {
      await tdb.pool.query(
        'ALTER TABLE deletion_receipt DISABLE TRIGGER deletion_receipt_freeze_trigger',
      );
      // Restore the captured original verbatim; canonicalisation is key-order
      // independent, so the recomputed hash matches again.
      await tdb.pool.query(`UPDATE deletion_receipt SET counts_json = $2 WHERE id = $1`, [
        victim.id,
        JSON.stringify(victim.counts_json),
      ]);
      await tdb.pool.query(
        'ALTER TABLE deletion_receipt ENABLE TRIGGER deletion_receipt_freeze_trigger',
      );
    }
    expect(verifyChain(await confirmedIn(SPACE_B), publicKey).ok).toBe(true);
  });

  it('legacy_receipt_verifies_byte_identically: the pre-spaces shape is the default space chain', async () => {
    const defaultSpace = await defaultSpaceId();
    const chain = await confirmedIn(defaultSpace);
    const legacy = chain.find((r) => r.id === legacyReceiptId);
    expect(legacy).toBeDefined();
    expect(legacy!.prev_hash).toBe(GENESIS_HASH);
    const result = verifyChain(chain, publicKey);
    expect(result.ok).toBe(true);
  });
});
