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
  DailyCounters,
} from '../infrastructure/index';
import {
  fakeEmbedding,
  settleJobs,
  startTestDatabase,
  startTestMinio,
  startTestQdrant,
} from '../testing/index';
import type { TestDatabase, TestMinio, TestQdrant } from '../testing/index';
import { NotesService, NotesSourceDeletion } from '../connectors/index';
import { MemoryStore } from './memory.store';
import { MemoryVectorStore } from './persistence/vector-store';
import { MemoryObjectStore } from './persistence/object-store';
import { DELETION_JOB_TYPE, DeletionExecutor, DeletionSaga } from './deletion-saga';
import type { SourceDeletion } from './deletion-saga';
import { IntegritySweep } from './integrity-sweep';
import { seedObjectFixture, seedOrphanPoint } from './dev-seed';
import { verifyChain } from './domain/receipt-chain';
import { TasksCascade } from '../tasks/index';
import type { ConfirmedReceipt } from './domain/receipt-chain';
import type { MemoryRow } from './persistence/tables';

const DIMS = 8;

const userA: Principal = {
  userId: 'user-a',
  name: 'User A',
  email: null,
  orgId: 'org-1',
  orgName: 'Org',
  roles: [],
};
const userB: Principal = { ...userA, userId: 'user-b', name: 'User B' };

describe('deletion saga (integration: real Postgres + Qdrant + MinIO)', () => {
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
      collection: 'deletion-test',
    });
    await vectors.ensureCollection();
    objects = new MemoryObjectStore({
      url: minio.url,
      accessKey: minio.accessKey,
      secretKey: minio.secretKey,
      bucket: 'cogeto',
    });
    await objects.ensureBucket();
    await objects.setBucketEncryption();

    store = new MemoryStore(tdb.db, vectors);
    notes = new NotesService(tdb.db, new DailyCounters(), {
      captureMax: 1_000_000,
      uploadMax: 1_000_000,
    });
    saga = new DeletionSaga(tdb.db, [new NotesSourceDeletion()]);
    executor = new DeletionExecutor(vectors, objects, keyDir);
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop(), minio.stop()]);
  });

  // ── Harness ─────────────────────────────────────────────────────────────────

  const tasksWith = (exec: DeletionExecutor): TaskList => ({
    [DELETION_JOB_TYPE]: idempotentTask(tdb.db, DELETION_JOB_TYPE, async (tx, payload) => {
      await exec.execute(tx, payload.source_id);
    }),
  });
  const runWorker = (exec: DeletionExecutor = executor) =>
    runOnce({ pgPool: tdb.pool, taskList: tasksWith(exec) });
  const pullRetries = async () => {
    // Settle first: since graphile-worker 0.17 the failure write can land after
    // runOnce resolves and would overwrite the pulled run_at with the backoff.
    await settleJobs(tdb.pool);
    await tdb.pool.query('UPDATE graphile_worker._private_jobs SET run_at = now()');
  };

  const embed = (rows: MemoryRow[]) =>
    store.upsertVectors(
      rows,
      rows.map((r) => fakeEmbedding(r.content ?? r.id, DIMS)),
    );
  const noteFact = (noteId: string, content: string) =>
    store.createFromFact(userA, {
      content,
      scope: 'private' as const,
      sourceType: 'user_note' as const,
      sourceId: noteId,
    });
  const memoryCount = async (sourceType: string, sourceId: string): Promise<number> => {
    const { rows } = await tdb.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM memory WHERE source_type = $1 AND source_id = $2',
      [sourceType, sourceId],
    );
    return Number(rows[0]!.n);
  };
  const getReceipt = async (id: string) => {
    const { rows } = await tdb.pool.query('SELECT * FROM deletion_receipt WHERE id = $1', [id]);
    return rows[0] as
      | {
          status: string;
          hash: string | null;
          signature: string | null;
          prev_hash: string | null;
          counts_json: Record<string, unknown>;
          signed_at: Date | null;
          confirmed_at: Date | null;
        }
      | undefined;
  };
  const confirmedReceipts = async (): Promise<ConfirmedReceipt[]> => {
    const { rows } = await tdb.pool.query(
      "SELECT * FROM deletion_receipt WHERE status = 'confirmed'",
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
  const auditCount = async (action: string, entityId: string): Promise<number> => {
    const { rows } = await tdb.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM audit_log WHERE action = $1 AND entity_id = $2',
      [action, entityId],
    );
    return Number(rows[0]!.n);
  };

  // ── The exit bar ────────────────────────────────────────────────────────────

  it('bucket_encryption: the bucket reports SSE default encryption (the health-check assertion)', async () => {
    expect(await objects.encryptionEnabled()).toBe(true);
  });

  it('deletion_cascade: note + seeded object → nothing left anywhere, receipt confirmed, signed, audited', async () => {
    // A note with two derived memories, plus the seeded object with one.
    const note = await notes.createNote(userA, 'Ana will send the Atlas proposal to Marko.');
    const m1 = await noteFact(note.id, 'Ana will send the Atlas proposal');
    const m2 = await noteFact(note.id, 'Marko receives the Atlas proposal');
    const seeded = await seedObjectFixture({ db: tdb.db, store, objects, principal: userA });
    await embed([m1, m2, seeded.memory]);
    expect((await vectors.retrievePayloads([m1.id, m2.id, seeded.memory.id])).size).toBe(3);
    expect(await objects.objectExists(seeded.objectKey)).toBe(true);

    // Saga step one: the enumeration transaction (note source).
    const { receiptId: noteReceipt } = await saga.requestSourceDeletion(
      userA,
      'user_note',
      note.id,
    );
    expect(await memoryCount('user_note', note.id)).toBe(0);
    expect(await notes.getNoteForOwner(userA, note.id)).toBeNull(); // source row gone too
    expect((await getReceipt(noteReceipt))?.status).toBe('pending');

    // Steps two + three (worker): Qdrant + confirmation.
    await runWorker();
    const confirmed = await getReceipt(noteReceipt);
    expect(confirmed?.status).toBe('confirmed');
    expect(confirmed?.hash).toBeTruthy();
    expect(confirmed?.signature).toBeTruthy();
    expect((await vectors.retrievePayloads([m1.id, m2.id])).size).toBe(0);

    // Now the file source: bytes + file_metadata + memory + point.
    const { receiptId: fileReceipt } = await saga.requestSourceDeletion(
      userA,
      'file',
      seeded.objectKey,
    );
    await runWorker();
    expect(await memoryCount('file', seeded.objectKey)).toBe(0);
    expect(await objects.objectExists(seeded.objectKey)).toBe(false);
    const fm = await tdb.pool.query('SELECT 1 FROM file_metadata WHERE object_key = $1', [
      seeded.objectKey,
    ]);
    expect(fm.rows).toHaveLength(0);
    expect((await vectors.retrievePayloads([seeded.memory.id])).size).toBe(0);
    expect((await getReceipt(fileReceipt))?.status).toBe('confirmed');

    // The chain of both receipts verifies against the instance public key.
    const publicKey = await loadInstancePublicKey(keyDir);
    expect(verifyChain(await confirmedReceipts(), publicKey)).toMatchObject({
      ok: true,
      verified: 2,
    });

    // Audited on both ends of the saga.
    for (const id of [noteReceipt, fileReceipt]) {
      expect(await auditCount('source.deletion_requested', id)).toBe(1);
      expect(await auditCount('deletion_receipt.confirmed', id)).toBe(1);
    }
  });

  it('saga_atomic_intent: a failure inside the enumeration transaction changes nothing anywhere', async () => {
    const note = await notes.createNote(userA, 'This note must survive the failed deletion.');
    const m = await noteFact(note.id, 'surviving fact');

    const failingAdapter: SourceDeletion = {
      sourceType: 'user_note',
      ownerOf: (tx, id) => new NotesSourceDeletion().ownerOf(tx, id),
      deleteSource: async () => {
        throw new Error('boom — injected failure inside the enumeration transaction');
      },
    };
    const failingSaga = new DeletionSaga(tdb.db, [failingAdapter]);

    const before = await tdb.pool.query<{ jobs: string; receipts: string; events: string }>(
      `SELECT (SELECT count(*) FROM graphile_worker.jobs)::text AS jobs,
              (SELECT count(*) FROM deletion_receipt)::text AS receipts,
              (SELECT count(*) FROM outbox_event)::text AS events`,
    );
    await expect(failingSaga.requestSourceDeletion(userA, 'user_note', note.id)).rejects.toThrow(
      /boom/,
    );
    const after = await tdb.pool.query<{ jobs: string; receipts: string; events: string }>(
      `SELECT (SELECT count(*) FROM graphile_worker.jobs)::text AS jobs,
              (SELECT count(*) FROM deletion_receipt)::text AS receipts,
              (SELECT count(*) FROM outbox_event)::text AS events`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]); // no receipt, no job, no event
    expect(await memoryCount('user_note', note.id)).toBe(1); // memory intact
    expect((await notes.getNoteForOwner(userA, note.id))?.id).toBe(note.id); // note intact
    expect((await store.getForPrincipal(userA, m.id))?.id).toBe(m.id);
  });

  it('saga_partial_failure_converges: Qdrant down on attempt one → receipt pending; retry confirms exactly once', async () => {
    const note = await notes.createNote(userA, 'Deletion must survive a Qdrant outage.');
    const m = await noteFact(note.id, 'fact behind a flaky index');
    await embed([m]);

    let failuresLeft = 1;
    const flakyVectors = {
      deletePoints: async (ids: string[]) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error('qdrant unavailable (simulated)');
        }
        return vectors.deletePoints(ids);
      },
    } as unknown as MemoryVectorStore;
    const flakyExecutor = new DeletionExecutor(flakyVectors, objects, keyDir);

    const { receiptId } = await saga.requestSourceDeletion(userA, 'user_note', note.id);
    await runWorker(flakyExecutor); // attempt 1: external leg fails, everything rolls back
    expect((await getReceipt(receiptId))?.status).toBe('pending');
    expect(await auditCount('deletion_receipt.confirmed', receiptId)).toBe(0);

    await pullRetries();
    await runWorker(flakyExecutor); // attempt 2: succeeds and confirms
    expect((await getReceipt(receiptId))?.status).toBe('confirmed');
    expect((await vectors.retrievePayloads([m.id])).size).toBe(0);

    // Exactly once: a duplicate delivery finds the idempotency claim and skips.
    await tdb.pool.query(`SELECT graphile_worker.add_job($1, payload := $2::json)`, [
      DELETION_JOB_TYPE,
      JSON.stringify({ source_type: 'deletion_receipt', source_id: receiptId }),
    ]);
    await runWorker();
    expect(await auditCount('deletion_receipt.confirmed', receiptId)).toBe(1);
  });

  it('receipt_never_premature: permanently failing object deletion → dead-letter, receipt stays pending forever', async () => {
    const seeded = await seedObjectFixture({ db: tdb.db, store, objects, principal: userA });
    await embed([seeded.memory]);

    const brokenObjects = {
      deleteObject: async () => {
        throw new Error('minio refuses (simulated permanent failure)');
      },
    } as unknown as MemoryObjectStore;
    const brokenExecutor = new DeletionExecutor(vectors, brokenObjects, keyDir);

    const { receiptId } = await saga.requestSourceDeletion(userA, 'file', seeded.objectKey);
    // Exhaust quickly: same semantics as 10 attempts, fewer iterations.
    await tdb.pool.query(
      "UPDATE graphile_worker._private_jobs SET max_attempts = 2 WHERE payload->>'source_id' = $1",
      [receiptId],
    );
    await runWorker(brokenExecutor);
    await pullRetries();
    await runWorker(brokenExecutor); // final attempt → dead-letter

    const receipt = await getReceipt(receiptId);
    expect(receipt?.status).toBe('pending'); // NEVER confirmed while a byte could exist
    expect(receipt?.hash).toBeNull();
    expect(receipt?.signature).toBeNull();
    const dead = await tdb.pool.query(
      "SELECT job_type FROM dead_letter WHERE payload->>'source_id' = $1",
      [receiptId],
    );
    expect(dead.rows).toHaveLength(1); // visible in the System dead-letter view

    // The dashboard retry path (re-enqueue) converges once the store recovers.
    await tdb.pool.query(`SELECT graphile_worker.add_job($1, payload := $2::json)`, [
      DELETION_JOB_TYPE,
      JSON.stringify({ source_type: 'deletion_receipt', source_id: receiptId }),
    ]);
    await runWorker(); // healthy executor
    expect((await getReceipt(receiptId))?.status).toBe('confirmed');
    expect(await objects.objectExists(seeded.objectKey)).toBe(false);
  });

  it('chain_integrity: sequential deletions form a verifiable chain; any tampering breaks it', async () => {
    const publicKey = await loadInstancePublicKey(keyDir);
    const receipts = await confirmedReceipts();
    expect(receipts.length).toBeGreaterThanOrEqual(3); // accumulated by the tests above
    expect(verifyChain(receipts, publicKey)).toMatchObject({ ok: true, verified: receipts.length });

    // Simulating tampering needs superuser force: confirmed receipts are frozen
    // by the migration-0010 trigger. An attacker strong enough to disable the
    // trigger is exactly who the hash chain exists to catch.
    await tdb.pool.query(
      'ALTER TABLE deletion_receipt DISABLE TRIGGER deletion_receipt_freeze_trigger',
    );

    // Tamper with one stored payload → the chain refuses it.
    const victim = receipts[1]!;
    await tdb.pool.query('UPDATE deletion_receipt SET counts_json = $1 WHERE id = $2', [
      JSON.stringify({ forged: true, memory_count: 0 }),
      victim.id,
    ]);
    expect(verifyChain(await confirmedReceipts(), publicKey).ok).toBe(false);
    await tdb.pool.query('UPDATE deletion_receipt SET counts_json = $1 WHERE id = $2', [
      JSON.stringify(victim.counts_json),
      victim.id,
    ]);
    expect(verifyChain(await confirmedReceipts(), publicKey).ok).toBe(true);

    // Tamper with a signature → broken; restore → whole again.
    await tdb.pool.query('UPDATE deletion_receipt SET signature = $1 WHERE id = $2', [
      Buffer.from('forged-signature').toString('base64'),
      victim.id,
    ]);
    const forged = verifyChain(await confirmedReceipts(), publicKey);
    expect(forged.ok).toBe(false);
    expect(forged.error).toMatch(/signature invalid/);
    await tdb.pool.query('UPDATE deletion_receipt SET signature = $1 WHERE id = $2', [
      victim.signature,
      victim.id,
    ]);
    expect(verifyChain(await confirmedReceipts(), publicKey).ok).toBe(true);

    await tdb.pool.query(
      'ALTER TABLE deletion_receipt ENABLE TRIGGER deletion_receipt_freeze_trigger',
    );
  });

  it('authz_owner_only: a non-owner cannot delete (or even see) another user’s source', async () => {
    const note = await notes.createNote(userA, 'User A private planning note.');
    const m = await noteFact(note.id, 'A-only fact');

    await expect(saga.requestSourceDeletion(userB, 'user_note', note.id)).rejects.toThrow(
      /not found/,
    );
    await expect(saga.previewSourceDeletion(userB, 'user_note', note.id)).rejects.toThrow(
      /not found/,
    );
    expect(await memoryCount('user_note', note.id)).toBe(1);
    expect((await store.getForPrincipal(userA, m.id))?.id).toBe(m.id);

    // The owner's own preview shows the exact confirm-dialog numbers.
    expect(await saga.previewSourceDeletion(userA, 'user_note', note.id)).toMatchObject({
      memoryCount: 1,
      objectCount: 0,
    });
  });

  it('task_cascade: deleting the source removes the derived task and the receipt records it', async () => {
    // A commitment memory derives a task (F3-B); erasing its source must take
    // the task with it, counted in the receipt (decision 0013 ruling 6).
    const note = await notes.createNote(userA, 'You will send Marko the draft contract.');
    const memory = await store.createFromFact(userA, {
      content: 'You will send Marko the draft contract.',
      scope: 'private',
      sourceType: 'user_note',
      sourceId: note.id,
      entities: ['Marko'],
      kind: 'commitment',
    });
    await embed([memory]);
    // Derive through the tasks module's own port implementation context: a
    // direct insert via the engine would need a gateway; the cascade is what
    // is under test, so seed the task row through the public cascade owner.
    const { TasksEngine } = await import('../tasks/index');
    const throwingGateway = {
      extractStructured: () => {
        throw new Error('no judgments expected');
      },
    } as never;
    const engine = new TasksEngine(tdb.db, store, throwingGateway);
    await tdb.db.transaction((tx) => engine.processSource(tx, 'user_note', note.id));
    expect(await engine.listForPrincipal(userA)).toHaveLength(1);

    const sagaWithCascade = new DeletionSaga(tdb.db, [new NotesSourceDeletion()], vectors, [
      new TasksCascade(),
    ]);
    const { receiptId } = await sagaWithCascade.requestSourceDeletion(userA, 'user_note', note.id);
    const receipt = await getReceipt(receiptId);
    expect((receipt?.counts_json as { tasks_removed?: number }).tasks_removed).toBe(1);
    expect(await engine.listForPrincipal(userA)).toHaveLength(0); // task gone
    expect(await memoryCount('user_note', note.id)).toBe(0);
  });

  it('cross_source_chain: same-source chains delete whole; cross-source chains null the dangling pointer and record it', async () => {
    // Same-source chain: edit-supersession keeps provenance, so enumeration
    // catches predecessor AND successor (§B.1 provability argument).
    const noteSame = await notes.createNote(userA, 'March pricing is 100.');
    const orig = await noteFact(noteSame.id, 'March pricing is 100');
    await store.editContent(userA, orig.id, 'March pricing is 120 (corrected)');
    const { receiptId: sameReceipt } = await saga.requestSourceDeletion(
      userA,
      'user_note',
      noteSame.id,
    );
    const sameCounts = (await getReceipt(sameReceipt))!.counts_json as { memory_count: number };
    expect(sameCounts.memory_count).toBe(2); // predecessor + successor, one query
    expect(await memoryCount('user_note', noteSame.id)).toBe(0);

    // Cross-source chain: a successor derived from a DIFFERENT note (the
    // reconciliation-merge shape). Deleting the successor's source removes
    // only that member and nulls the survivor's dangling pointer.
    const noteX = await notes.createNote(userA, 'Offsite is in Split.');
    const noteY = await notes.createNote(userA, 'Correction: offsite moved to Zadar.');
    const mA = await noteFact(noteX.id, 'Offsite is in Split');
    const { successor: mB } = await store.supersede({ kind: 'user', userId: userA.userId }, mA.id, {
      content: 'Offsite moved to Zadar',
      scope: 'private',
      sourceType: 'user_note',
      sourceId: noteY.id,
    });
    expect((await store.getForPrincipal(userA, mA.id))?.supersededBy).toBe(mB.id);

    const { receiptId: crossReceipt } = await saga.requestSourceDeletion(
      userA,
      'user_note',
      noteY.id,
    );
    const crossCounts = (await getReceipt(crossReceipt))!.counts_json as {
      memory_ids: string[];
      superseded_by_nulled: string[];
    };
    expect(crossCounts.memory_ids).toEqual([mB.id]); // only noteY's member
    expect(crossCounts.superseded_by_nulled).toEqual([mA.id]); // recorded in the receipt
    const survivor = await store.getForPrincipal(userA, mA.id);
    expect(survivor?.supersededBy).toBeNull(); // pointer nulled, row intact
    expect(survivor?.status).toBe('replaced'); // its own lifecycle is untouched
    expect(await memoryCount('user_note', noteX.id)).toBe(1);

    await runWorker(); // both receipts confirm; the chain still verifies
    const publicKey = await loadInstancePublicKey(keyDir);
    expect(verifyChain(await confirmedReceipts(), publicKey).ok).toBe(true);
  });

  // ── F1-B: the nightly sweep + receipt permanence ────────────────────────────

  it('sweep_clean: with clean stores, the sweep verifies every confirmed receipt and raises nothing', async () => {
    const sweep = new IntegritySweep(tdb.db, vectors, objects, keyDir);
    const report = await sweep.run();
    expect(report.receiptsChecked).toBeGreaterThanOrEqual(3);
    expect(report.identifiersChecked).toBeGreaterThan(0);
    expect(report).toMatchObject({ newAlerts: 0, openAlerts: 0, chainOk: true });

    // The run left its ledger entry — what /api/health and System read.
    const status = await sweep.status();
    expect(status.lastSweepAt).not.toBeNull();
    expect(status.lastReport).toMatchObject({ chainOk: true, openAlerts: 0 });
  });

  it('sweep_detects_orphan: an injected point triggers exactly one alert, idempotent on re-run', async () => {
    const sweep = new IntegritySweep(tdb.db, vectors, objects, keyDir);
    const planted = await seedOrphanPoint({
      db: tdb.db,
      qdrant: {
        url: qdrant.url,
        embeddingModel: 'test-embed',
        dimensions: DIMS,
        collection: 'deletion-test',
      },
    });
    expect(planted).not.toBeNull();

    const first = await sweep.run();
    expect(first).toMatchObject({ newAlerts: 1, openAlerts: 1, chainOk: true });
    const alerts = await sweep.listAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      receiptId: planted!.receiptId,
      kind: 'qdrant_point_present',
      detail: planted!.pointId,
    });

    // Re-detection is idempotent: the same violation stays ONE alert row.
    const second = await sweep.run();
    expect(second).toMatchObject({ newAlerts: 0, openAlerts: 1 });
    expect(await sweep.listAlerts()).toHaveLength(1);

    // Owner resolves the drill (removes the stray point + the alert row);
    // a final sweep confirms the instance is whole again.
    await vectors.deletePoints([planted!.pointId]);
    await tdb.pool.query('DELETE FROM integrity_alert WHERE receipt_id = $1', [planted!.receiptId]);
    expect(await sweep.run()).toMatchObject({ newAlerts: 0, openAlerts: 0, chainOk: true });
  });

  it('receipts_immutable: receipts cannot be deleted, and a confirmed receipt cannot change', async () => {
    // No public interface exposes a receipt mutation: the module barrel exports
    // no update/delete, and /api/receipts has only GET routes. Below the API,
    // the database enforces the same rule (migration 0010).
    const confirmed = await confirmedReceipts();
    expect(confirmed.length).toBeGreaterThan(0);

    await expect(tdb.pool.query('DELETE FROM deletion_receipt')).rejects.toThrow(/permanent/);
    await expect(
      tdb.pool.query("UPDATE deletion_receipt SET source_id = 'forged' WHERE id = $1", [
        confirmed[0]!.id,
      ]),
    ).rejects.toThrow(/immutable/);

    // The one legal write survives: the saga's pending → confirmed transition
    // (exercised throughout this suite) — everything after that is frozen.
    expect((await confirmedReceipts()).length).toBe(confirmed.length);
  });
});
