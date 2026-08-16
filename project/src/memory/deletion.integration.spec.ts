import { randomUUID } from 'node:crypto';
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
import { MemoryStore } from './memory.store';
import { MemoryVectorStore } from './persistence/vector-store';
import { MemoryObjectStore } from './persistence/object-store';
import {
  DELETION_JOB_TYPE,
  DeletionExecutor,
  DeletionSaga,
  countedRemovals,
  parseReceiptCounts,
} from './deletion-saga';
import type { DerivedCascade, SourceDeletion } from './deletion-saga';
import { IntegritySweep } from './integrity-sweep';
import { ReceiptsController } from './receipts.controller';
import { seedObjectFixture, seedOrphanPoint } from './dev-seed';
import { verifyChain } from './domain/receipt-chain';
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
    notes = new NotesService(tdb.db, new InMemoryDailyCounters(), {
      captureMax: 1_000_000,
      uploadMax: 1_000_000,
    });
    saga = new DeletionSaga(tdb.db, { adapters: [new NotesSourceDeletion()] });
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
    const failingSaga = new DeletionSaga(tdb.db, { adapters: [failingAdapter] });

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

  it('verify_scoped_to_the_caller: the verdict is instance-wide, the numbers are the caller’s own (V2.0 item 3.7)', async () => {
    // Every receipt accumulated above was requested by userA. The endpoint used
    // to hand any authenticated caller the instance-wide confirmed and pending
    // counts plus a first-error string naming a receipt id.
    const controller = new ReceiptsController(tdb.db, keyDir, 'admin');
    const instanceWide = (await confirmedReceipts()).length;
    expect(instanceWide).toBeGreaterThanOrEqual(3);

    const asAdmin = await controller.verify({ principal: { ...userA, roles: ['admin'] } } as never);
    expect(asAdmin).toMatchObject({ ok: true, verified: instanceWide, confirmed: instanceWide });

    // userB caused none of them: same verdict, none of the counts.
    const asPeer = await controller.verify({ principal: userB } as never);
    expect(asPeer).toEqual({ ok: true, verified: 0, confirmed: 0, pending: 0 });
    expect(asPeer).not.toHaveProperty('error');

    // The owner still sees their own ledger's size, which is what the pill on
    // the Forgotten page reports.
    const asOwner = await controller.verify({ principal: userA } as never);
    expect(asOwner).toMatchObject({ ok: true, confirmed: instanceWide });
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

  it('registry_boundary: an unregistered source type is rejected at the API exactly as the enum rejected it; a defunct type stays a KNOWN value that fails only on its missing adapter', async () => {
    // The database no longer enumerates the vocabulary (migration 0040), so
    // THIS boundary is what keeps an unknown value out of the saga and out of
    // deletion_receipt.
    await expect(saga.requestSourceDeletion(userA, 'not_a_registered_type', 'x')).rejects.toThrow(
      /unknown source type/,
    );
    await expect(saga.previewSourceDeletion(userA, 'not_a_registered_type', 'x')).rejects.toThrow(
      /unknown source type/,
    );
    // Defunct is registered, not unknown: it passes validation and fails only
    // because nothing binds an adapter for it — the exact pre-registry
    // behaviour, and what the 1.x upgrade CLI relies on when it DOES bind one.
    await expect(saga.requestSourceDeletion(userA, 'calendar_event', 'x')).rejects.toThrow(
      /no deletion adapter registered/,
    );
    // Neither refusal left a receipt behind: the ledger never gains an entry
    // for a source the saga refused to touch.
    const { rows } = await tdb.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM deletion_receipt
       WHERE source_type IN ('not_a_registered_type', 'calendar_event')`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('cross_source_chain: same-source chains delete whole; cross-source chains null the dangling pointer and record it', async () => {
    // Same-source chain: edit-supersession keeps provenance, so enumeration
    // catches predecessor AND successor (spec §11.1 provability argument).
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

  // ──: the nightly sweep + receipt permanence ────────────────────────────

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

  it('empty_enumeration_no_receipt: the chain never gains an attestation of nothing (SEC-30)', async () => {
    const before = await confirmedReceipts();

    // A source that does not exist erases nothing, and 404s before any receipt
    // row is written. This is the case SEC-30 was about, and it is closed by
    // refusing the request rather than by signing an empty attestation.
    await expect(saga.requestSourceDeletion(userA, 'user_note', randomUUID())).rejects.toThrow(
      /not found/,
    );

    // A source that EXISTS but has produced nothing yet is a different thing,
    // and it does get a receipt. Deleting a just-captured note erases the note
    // row and consumes the pipeline's idempotency key, so the content can never
    // resurrect; a receipt reading "0 memories, 0 objects" is the honest record
    // of exactly that. Counting it as nothing would have been the bug.
    const note = await notes.createNote(userA, 'Nothing durable in here.');
    const { receiptId } = await saga.requestSourceDeletion(userA, 'user_note', note.id);
    expect(receiptId).not.toBeNull();
    expect(await notes.getNoteForOwner(userA, note.id)).toBeNull();

    await runWorker();
    const after = await confirmedReceipts();
    // Exactly one new receipt: the real deletion, and nothing from the 404.
    expect(after.length).toBe(before.length + 1);
    // And the chain still verifies end to end across the change.
    const publicKeyPem = await loadInstancePublicKey(keyDir);
    expect(verifyChain(after, publicKeyPem).ok).toBe(true);
  });

  // ── Receipt completeness (issue #635) ──────────────────────────────────────

  it('receipt_counts_every_cascade: each newly counted class appears in the signed payload', async () => {
    // Six cascades ran inside the signed transaction and appeared nowhere in
    // the artifact that attests to it. The saga's own accumulation is what
    // changed, so this exercises it directly: one stub per artifact name,
    // reporting one removal each through the real `cascadeForSource` port.
    const counting = (artifact: string): DerivedCascade => ({
      artifact,
      cascadeForMemories: async () => 0,
      cascadeForSource: async () => 1,
    });
    const countingSaga = new DeletionSaga(tdb.db, {
      adapters: [new NotesSourceDeletion()],
      derivedCascades: [
        counting('source_contexts'),
        counting('confluence_pages'),
        counting('source_revisions'),
        counting('extraction_refusals'),
        counting('ingestion_progress'),
        counting('project_assignments_released'),
        counting('file_read_reports'),
        counting('chat_attachments'),
        counting('connector_items'),
      ],
    });

    const note = await notes.createNote(userA, 'A note whose whole cascade is now counted.');
    const { receiptId } = await countingSaga.requestSourceDeletion(userA, 'user_note', note.id);
    expect(receiptId).not.toBeNull();

    const counts = parseReceiptCounts((await getReceipt(receiptId!))!.counts_json);
    // The two content-bearing ones, which are the reason this was worth fixing:
    // anchoring subjects and Confluence titles are the documents' own words.
    expect(counts.source_contexts_removed).toBe(1);
    expect(counts.confluence_pages_removed).toBe(1);
    // The structural legs, counted so the receipt accounts for the whole act.
    expect(counts.source_revisions_removed).toBe(1);
    expect(counts.extraction_refusals_removed).toBe(1);
    expect(counts.ingestion_progress_removed).toBe(1);
    expect(counts.project_assignments_released).toBe(1);
    // And the three that were accumulated but left out of the SEC-30 guard.
    expect(counts.file_read_reports_removed).toBe(1);
    expect(counts.chat_attachments_removed).toBe(1);
    expect(counts.connector_items_erased).toBe(1);

    await runWorker();
    expect((await getReceipt(receiptId!))?.status).toBe('confirmed');
    // The widened payload signs and chains exactly like every receipt before it.
    expect(verifyChain(await confirmedReceipts(), await loadInstancePublicKey(keyDir)).ok).toBe(
      true,
    );
  });

  it('receipt_written_when_only_an_uncounted_class_was_erased (SEC-30 guard, issue #635)', async () => {
    // The old guard named nine of the sixteen cascades. A deletion whose only
    // effect was one of the other seven reported "nothing erasable derived from
    // this source", wrote `source.deleted_empty` to the audit trail, and
    // returned no receipt: the erasure happened and the proof did not.
    //
    // Reaching that state through the public method needs a source with no row
    // and no memories, which `enumerateAndAuthorize` refuses first — so the
    // guard is defence in depth rather than a live path, and is proved here at
    // the level it actually operates: the saga's own counting, over a real
    // deletion, with every other signal deliberately zero.
    const note = await notes.createNote(userA, 'Only a read report survives this one.');
    const onlyReadReport = new DeletionSaga(tdb.db, {
      adapters: [new NotesSourceDeletion()],
      derivedCascades: [
        {
          artifact: 'file_read_reports',
          cascadeForMemories: async () => 0,
          cascadeForSource: async () => 2,
        },
      ],
    });
    const { receiptId } = await onlyReadReport.requestSourceDeletion(userA, 'user_note', note.id);
    expect(receiptId).not.toBeNull();

    const counts = parseReceiptCounts((await getReceipt(receiptId!))!.counts_json);
    expect(counts.memory_count).toBe(0);
    expect(counts.object_keys).toEqual([]);
    expect(counts.file_read_reports_removed).toBe(2);
    // countedRemovals sees it, so the receipt exists rather than a
    // `deleted_empty` audit entry standing in for one.
    expect(countedRemovals(counts)).toBeGreaterThan(0);
    expect(await auditCount('source.deleted_empty', note.id)).toBe(0);
  });
});
