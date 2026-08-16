import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOnce } from 'graphile-worker';
import type { TaskList } from 'graphile-worker';
import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Principal } from '@cogeto/shared';
import {
  ensureInstanceKeys,
  idempotentTask,
  loadInstancePublicKey,
  InMemoryDailyCounters,
} from '../infrastructure/index';
import {
  fakeEmbedding,
  startTestDatabase,
  startTestMinio,
  startTestQdrant,
} from '../testing/index';
import type { TestDatabase, TestMinio, TestQdrant } from '../testing/index';
import { NotesService, NotesSourceDeletion } from '../notes/index';
import { ChatSourceDeletion, ConversationSourceDeletion } from '../chat/index';
import { EmailSourceDeletion } from '../email/index';
import { WebSourceDeletion } from '../research/index';
import { AdminGuard } from '../identity/index';
import type { AuthenticatedRequest } from '../identity/index';
import { MemoryStore } from './memory.store';
import { MemoryVectorStore } from './persistence/vector-store';
import { MemoryObjectStore } from './persistence/object-store';
import { fileMetadata } from './persistence/tables';
import { DELETION_JOB_TYPE, DeletionExecutor, DeletionSaga } from './deletion-saga';
import { OwnerErasureService, unerasableSourceTypes } from './owner-erasure.service';
import { OwnerErasureController } from './erasure.controller';
import { verifyChain } from './domain/receipt-chain';
import type { ConfirmedReceipt } from './domain/receipt-chain';

const DIMS = 8;
const ORG = 'org-1';

/** The departed user. Deactivated in Zitadel: no session, no directory row. */
const leaver: Principal = {
  userId: 'user-leaver',
  name: 'Departed',
  email: null,
  orgId: ORG,
  orgName: 'Org',
  roles: [],
};
/** A colleague who stays, and whose material must be untouched. */
const peer: Principal = { ...leaver, userId: 'user-peer', name: 'Peer' };
/** The administrator who invokes the erasure. */
const admin: Principal = { ...leaver, userId: 'user-admin', name: 'Admin', roles: ['admin'] };
/** An ordinary member, who must not be able to. */
const member: Principal = { ...leaver, userId: 'user-member', roles: ['member'] };

/**
 * owner_erasure (issue #632) — the administrative path that erases a departed
 * user's private material through the ordinary saga.
 *
 * Real Postgres, Qdrant and MinIO, because the claim is "gone across every
 * store with a verifying receipt" and a mocked store cannot support it.
 */
describe('owner_erasure (integration: real Postgres + Qdrant + MinIO)', () => {
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
  let erasure: OwnerErasureService;
  let controller: OwnerErasureController;

  beforeAll(async () => {
    [tdb, qdrant, minio] = await Promise.all([
      startTestDatabase(),
      startTestQdrant(),
      startTestMinio(),
    ]);
    keyDir = mkdtempSync(path.join(tmpdir(), 'cogeto-erasure-keys-'));
    await ensureInstanceKeys(keyDir);

    vectors = new MemoryVectorStore({
      url: qdrant.url,
      embeddingModel: 'test-embed',
      dimensions: DIMS,
      collection: 'erasure-test',
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
    saga = new DeletionSaga(tdb.db, { adapters });
    executor = new DeletionExecutor(vectors, objects, keyDir);
    erasure = new OwnerErasureService(tdb.db, saga, adapters);
    controller = new OwnerErasureController(erasure);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop(), minio.stop()]);
  });

  // ── Harness ────────────────────────────────────────────────────────────────

  /** Built lazily: the containers only exist once `beforeAll` has run. */
  const tasks = (): TaskList => ({
    [DELETION_JOB_TYPE]: idempotentTask(tdb.db, DELETION_JOB_TYPE, async (tx, payload) => {
      await executor.execute(tx, payload.source_id);
    }),
  });
  const runWorker = () => runOnce({ pgPool: tdb.pool, taskList: tasks() });

  /** A note plus one derived memory, embedded, at the given scope. */
  const noteWithFact = async (owner: Principal, text: string, scope: 'private' | 'shared') => {
    const note = await notes.createNote(owner, text, scope);
    const fact = await store.createFromFact(owner, {
      content: text,
      scope,
      sourceType: 'user_note' as const,
      sourceId: note.id,
    });
    await store.upsertVectors([fact], [fakeEmbedding(fact.content ?? fact.id, DIMS)]);
    return { note, fact };
  };

  /** A stored file source: object bytes + file_metadata + a derived memory. */
  const fileWithFact = async (owner: Principal, scope: 'private' | 'shared') => {
    const bytes = Buffer.from(`bytes for ${owner.userId} ${randomUUID()}`, 'utf8');
    const objectKey = `${owner.orgId}/${owner.userId}/${scope}/file-${randomUUID()}`;
    await objects.putObject(objectKey, bytes);
    await tdb.db.insert(fileMetadata).values({
      objectKey,
      ownerId: owner.userId,
      scope,
      sensitive: false,
      checksum: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
    });
    const fact = await store.createFromFact(owner, {
      content: `a fact from ${objectKey}`,
      scope,
      sourceType: 'file' as const,
      sourceId: objectKey,
    });
    await store.upsertVectors([fact], [fakeEmbedding(fact.content ?? fact.id, DIMS)]);
    return { objectKey, fact };
  };

  const memoryExists = async (id: string): Promise<boolean> => {
    const { rows } = await tdb.pool.query('SELECT 1 FROM memory WHERE id = $1', [id]);
    return rows.length > 0;
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
  const auditRows = async (action: string, entityId: string) => {
    const { rows } = await tdb.pool.query(
      'SELECT actor, owner_id, detail_json FROM audit_log WHERE action = $1 AND entity_id = $2',
      [action, entityId],
    );
    return rows as { actor: string; owner_id: string | null; detail_json: unknown }[];
  };

  // ── The exit bar ───────────────────────────────────────────────────────────

  it('erases every private artifact across all three stores, with verifying receipts', async () => {
    const one = await noteWithFact(leaver, 'A private note from the leaver.', 'private');
    const two = await noteWithFact(leaver, 'Another private note.', 'private');
    const file = await fileWithFact(leaver, 'private');

    // Present everywhere before.
    expect((await vectors.retrievePayloads([one.fact.id, two.fact.id, file.fact.id])).size).toBe(3);
    expect(await objects.objectExists(file.objectKey)).toBe(true);

    const result = await erasure.run('user-leaver', 'user:user-admin', ORG);
    expect(result.erased).toHaveLength(3);
    expect(result.failed).toEqual([]);
    await runWorker();

    // Postgres: memories and source rows gone.
    expect(await memoryExists(one.fact.id)).toBe(false);
    expect(await memoryExists(two.fact.id)).toBe(false);
    expect(await memoryExists(file.fact.id)).toBe(false);
    expect(await notes.getNoteForOwner(leaver, one.note.id)).toBeNull();
    const { rows: fileRows } = await tdb.pool.query(
      'SELECT 1 FROM file_metadata WHERE object_key = $1',
      [file.objectKey],
    );
    expect(fileRows).toHaveLength(0);
    // Qdrant: no points.
    expect((await vectors.retrievePayloads([one.fact.id, two.fact.id, file.fact.id])).size).toBe(0);
    // MinIO: no bytes.
    expect(await objects.objectExists(file.objectKey)).toBe(false);

    // One receipt per source, every one of them confirmed and chained.
    const receipts = await confirmedReceipts();
    expect(receipts.length).toBeGreaterThanOrEqual(3);
    expect(verifyChain(receipts, await loadInstancePublicKey(keyDir)).ok).toBe(true);
    // Each receipt attributes the erasure to the SUBJECT, which is whose
    // material it was — the administrator is on the audit trail, not here.
    for (const id of result.erased.map((e) => e.receiptId)) {
      const { rows } = await tdb.pool.query(
        'SELECT counts_json FROM deletion_receipt WHERE id=$1',
        [id],
      );
      expect((rows[0] as { counts_json: { requested_by: string } }).counts_json.requested_by).toBe(
        'user-leaver',
      );
    }
  });

  it('the audit trail names BOTH the administrator and the subject', async () => {
    const entries = await auditRows('user.erased', 'user-leaver');
    expect(entries.length).toBeGreaterThan(0);
    const latest = entries[entries.length - 1]!;
    expect(latest.actor).toBe('user:user-admin');
    expect(latest.owner_id).toBe('user-leaver');
    expect((latest.detail_json as { subject: string }).subject).toBe('user-leaver');

    // And every per-source deletion entry carries the same pair, so the trail
    // reads correctly source by source and not only in the summary.
    const { rows } = await tdb.pool.query(
      `SELECT actor, detail_json FROM audit_log
        WHERE action = 'source.deletion_requested' AND detail_json->>'onBehalfOf' = 'user-leaver'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows as { actor: string }[]) expect(row.actor).toBe('user:user-admin');
  });

  it('shared material owned by the subject survives untouched', async () => {
    const shared = await noteWithFact(leaver, 'A shared fact the team still needs.', 'shared');
    const sharedFile = await fileWithFact(leaver, 'shared');
    const privateOne = await noteWithFact(leaver, 'Private, and going.', 'private');

    const plan = await erasure.plan('user-leaver');
    expect(plan.retainedShared.map((s) => s.sourceId).sort()).toEqual(
      [shared.note.id, sharedFile.objectKey].sort(),
    );

    const result = await erasure.run('user-leaver', 'user:user-admin', ORG);
    await runWorker();

    // The private one went.
    expect(await memoryExists(privateOne.fact.id)).toBe(false);
    // The shared ones are entirely intact: row, memory, vector, bytes.
    expect(await memoryExists(shared.fact.id)).toBe(true);
    expect(await notes.getNoteForOwner(leaver, shared.note.id)).not.toBeNull();
    expect(await memoryExists(sharedFile.fact.id)).toBe(true);
    expect(await objects.objectExists(sharedFile.objectKey)).toBe(true);
    expect((await vectors.retrievePayloads([shared.fact.id])).size).toBe(1);

    // And they are reported as retained, with the reason, rather than silently
    // skipped: an administrator has to be able to see what stayed and why.
    expect(result.retained.filter((r) => r.reason === 'shared_source')).toHaveLength(2);
  });

  it('a private source holding a SHARED derived fact is retained whole', async () => {
    // The boundary case the guard exists for: scope is stamped from the source
    // at ingestion, but a user can re-scope one memory afterwards. Erasing by
    // provenance would take the shared fact with it.
    const note = await notes.createNote(leaver, 'Private note, one shared finding.', 'private');
    const privateFact = await store.createFromFact(leaver, {
      content: 'the private half',
      scope: 'private',
      sourceType: 'user_note' as const,
      sourceId: note.id,
    });
    const sharedFact = await store.createFromFact(leaver, {
      content: 'the half the team relies on',
      scope: 'shared',
      sourceType: 'user_note' as const,
      sourceId: note.id,
    });

    // The plan cannot see this: the SOURCE is private.
    const plan = await erasure.plan('user-leaver');
    expect(plan.toErase.some((s) => s.sourceId === note.id)).toBe(true);

    const result = await erasure.run('user-leaver', 'user:user-admin', ORG);
    expect(result.retained).toContainEqual({
      sourceType: 'user_note',
      sourceId: note.id,
      reason: 'shared_derived_fact',
    });

    // NOTHING about the source moved: the shared fact, the private facts
    // beside it, and the source row are all still there. Retaining more than
    // strictly necessary is the direction the rule requires.
    expect(await memoryExists(sharedFact.id)).toBe(true);
    expect(await memoryExists(privateFact.id)).toBe(true);
    expect(await notes.getNoteForOwner(leaver, note.id)).not.toBeNull();
  });

  it('a source whose scope CHANGED is judged by its scope now, not its history', async () => {
    // No scope history exists on a source row, and the present value is the
    // right one anyway: it is the scope under which colleagues can read the
    // material today.
    const wasShared = await noteWithFact(leaver, 'Was shared, now private.', 'shared');
    await tdb.pool.query('UPDATE note SET scope = $1 WHERE id = $2', [
      'private',
      wasShared.note.id,
    ]);
    await tdb.pool.query('UPDATE memory SET scope = $1 WHERE id = $2', [
      'private',
      wasShared.fact.id,
    ]);

    const wasPrivate = await noteWithFact(leaver, 'Was private, now shared.', 'private');
    await tdb.pool.query('UPDATE note SET scope = $1 WHERE id = $2', [
      'shared',
      wasPrivate.note.id,
    ]);
    await tdb.pool.query('UPDATE memory SET scope = $1 WHERE id = $2', [
      'shared',
      wasPrivate.fact.id,
    ]);

    await erasure.run('user-leaver', 'user:user-admin', ORG);
    await runWorker();

    expect(await memoryExists(wasShared.fact.id)).toBe(false); // private now → gone
    expect(await memoryExists(wasPrivate.fact.id)).toBe(true); // shared now → stays
  });

  it('nothing owned by anyone else is affected', async () => {
    const peerPrivate = await noteWithFact(peer, 'The colleague’s private note.', 'private');
    const peerShared = await noteWithFact(peer, 'The colleague’s shared note.', 'shared');
    const leaverPrivate = await noteWithFact(leaver, 'The leaver’s last private note.', 'private');

    await erasure.run('user-leaver', 'user:user-admin', ORG);
    await runWorker();

    expect(await memoryExists(leaverPrivate.fact.id)).toBe(false);
    // The peer is untouched in both scopes — an erasure is scoped to ONE owner.
    expect(await memoryExists(peerPrivate.fact.id)).toBe(true);
    expect(await memoryExists(peerShared.fact.id)).toBe(true);
    expect(await notes.getNoteForOwner(peer, peerPrivate.note.id)).not.toBeNull();
    expect(await notes.getNoteForOwner(peer, peerShared.note.id)).not.toBeNull();

    // And the plan for the peer never contained the leaver's material either.
    const peerPlan = await erasure.plan('user-peer');
    expect(peerPlan.toErase.every((s) => s.sourceId !== leaverPrivate.note.id)).toBe(true);
  });

  it('works from the stored owner id alone: no session, no identity-provider row', async () => {
    // The state the feature exists for. Nothing in this test hands the subject
    // to any code path as a Principal, and nothing resolves them anywhere: the
    // subject is the string 'user-gone', which is exactly what a deactivated
    // or deleted Zitadel account leaves behind on the rows it owned.
    const ghost: Principal = { ...leaver, userId: 'user-gone' };
    const orphan = await noteWithFact(ghost, 'Left behind by someone deleted.', 'private');

    // No directory row is created and none is consulted.
    const { rows: directory } = await tdb.pool.query('SELECT 1 FROM app_user WHERE user_id = $1', [
      'user-gone',
    ]);
    expect(directory).toHaveLength(0);

    const result = await erasure.run('user-gone', 'user:user-admin', ORG);
    await runWorker();
    expect(result.erased).toHaveLength(1);
    expect(await memoryExists(orphan.fact.id)).toBe(false);
    expect(verifyChain(await confirmedReceipts(), await loadInstancePublicKey(keyDir)).ok).toBe(
      true,
    );
  });

  // ── Who may invoke it ──────────────────────────────────────────────────────

  describe('administrative only', () => {
    const contextFor = (principal: Principal): ExecutionContext =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ principal }) }),
      }) as unknown as ExecutionContext;
    const req = (principal: Principal) => ({ principal }) as unknown as AuthenticatedRequest;

    it('the controller declares AdminGuard', () => {
      const guards = (Reflect.getMetadata('__guards__', OwnerErasureController) ?? []) as unknown[];
      expect(guards).toContain(AdminGuard);
    });

    it('refuses a member without the administrative role', () => {
      const guard = new AdminGuard({ adminRole: 'admin' } as never);
      expect(() => guard.canActivate(contextFor(member))).toThrow(ForbiddenException);
      expect(guard.canActivate(contextFor(admin))).toBe(true);
    });

    it('requires the confirmation to repeat the subject id', async () => {
      await expect(
        controller.erase(req(admin), 'user-peer', { confirmUserId: 'user-someone-else' }),
      ).rejects.toMatchObject({ status: 400 });
      // A missing confirmation is a 400 too, not a silent erasure.
      await expect(controller.erase(req(admin), 'user-peer', {})).rejects.toMatchObject({
        status: 400,
      });
    });

    it('refuses an administrator erasing themselves through this path', async () => {
      await expect(
        controller.erase(req(admin), 'user-admin', { confirmUserId: 'user-admin' }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('accepts a correct confirmation, audits the request and returns honest numbers', async () => {
      const answer = await controller.erase(req(admin), 'user-peer', {
        confirmUserId: 'user-peer',
      });
      expect(answer.accepted).toBe(true);
      expect(answer.subjectUserId).toBe('user-peer');
      // The peer has one private and one shared note from an earlier case.
      expect(answer.toEraseCount).toBeGreaterThan(0);
      expect(answer.retainedSharedCount).toBeGreaterThan(0);

      const requested = await auditRows('user.erasure_requested', 'user-peer');
      expect(requested).toHaveLength(1);
      expect(requested[0]!.actor).toBe('user:user-admin');
      expect(requested[0]!.owner_id).toBe('user-peer');
    });
  });

  it('every non-defunct source type is reachable by an erasure', () => {
    // The failure mode this whole feature exists to remove is material nobody
    // can reach. A new source type whose adapter forgets `listForOwner` would
    // be silently skipped by every erasure, which is that failure mode wearing
    // a different hat — and it would be skipped QUIETLY, with the erasure
    // reporting success.
    //
    // The full adapter set as both composition roots bind it. `chat` counts as
    // covered because it IMPLEMENTS the port and returns nothing on purpose:
    // its messages are cascade members of their conversation, so listing them
    // separately would enumerate the same content twice.
    const adapters = [
      new NotesSourceDeletion(),
      new ChatSourceDeletion(),
      new ConversationSourceDeletion(),
      new EmailSourceDeletion(),
      new WebSourceDeletion(),
    ];
    expect(
      unerasableSourceTypes(adapters),
      'a registered, non-defunct source type that owner erasure cannot enumerate: its ' +
        'material would survive an erasure and the run would still report success. Give its ' +
        'SourceDeletion adapter a listForOwner, or declare an empty one with the reason.',
    ).toEqual([]);
  });
});
