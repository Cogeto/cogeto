import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase, startTestMinio, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestMinio, TestQdrant } from '../testing/index';
import {
  canonicalize,
  createMemoryStore,
  GENESIS_HASH,
  MemoryFileStore,
  MemoryObjectStore,
  verifyChain,
  type ConfirmedReceipt,
  type MemoryStore,
} from '../memory/index';
import { TasksEngine } from '../tasks/index';
import { UserDirectory } from '../identity/index';
import type { ModelGateway } from '../model-gateway/index';
import { ensureInstanceKeys, loadInstanceSigner } from '../infrastructure/index';
import { PassportExportExecutor } from './passport-export.executor';
import { PassportExportStore } from './passport.store';
import { readZip } from './zip';
import { sha256Hex, PASSPORT_PATHS } from './passport-format';

const DIMS = 8;
const principalFor = (userId: string, orgId = 'org-passport'): Principal => ({
  userId,
  name: 'Passport Tester',
  email: null,
  orgId,
  orgName: orgId,
  roles: [],
});

/**
 * The Memory Passport export end to end (real Postgres + Qdrant + MinIO): the
 * worker-run executor re-reads through the gated interfaces and stores a signed
 * archive. These pin the two properties the whole feature turns on —
 * completeness (nothing the user owns is missing) and gating (nothing another
 * user's private/sensitive data ever leaks in).
 */
describe('memory passport export (integration)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let minio: TestMinio;
  let store: MemoryStore;
  let objects: MemoryObjectStore;
  let executor: PassportExportExecutor;
  let passportStore: PassportExportStore;
  let keyDir: string;

  beforeAll(async () => {
    [tdb, qdrant, minio] = await Promise.all([
      startTestDatabase(),
      startTestQdrant(),
      startTestMinio(),
    ]);
    store = createMemoryStore({
      db: tdb.db,
      qdrant: { url: qdrant.url, embeddingModel: 'test-embed', dimensions: DIMS },
    });
    await store.ensureIndexReady();
    objects = new MemoryObjectStore({
      url: minio.url,
      accessKey: minio.accessKey,
      secretKey: minio.secretKey,
      bucket: 'cogeto',
    });
    await objects.ensureBucket();
    keyDir = await mkdtemp(join(tmpdir(), 'passport-key-'));
    await ensureInstanceKeys(keyDir);
    const tasks = new TasksEngine(tdb.db, store, {} as unknown as ModelGateway);
    passportStore = new PassportExportStore(tdb.db);
    executor = new PassportExportExecutor(
      store,
      tasks,
      objects,
      new MemoryFileStore(tdb.db),
      passportStore,
      new UserDirectory(tdb.db),
      { instanceKeyDir: keyDir, downloadUrlTtlSeconds: 300, exportRetentionHours: 24 },
    );
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop(), minio.stop()]);
  });

  const seed = (owner: string, content: string, over: Record<string, unknown> = {}) =>
    store.createFromFact(principalFor(owner), {
      content,
      scope: (over['scope'] as 'private' | 'shared') ?? 'private',
      sourceType: 'user_note',
      sourceId: randomUUID(),
      subjectEntity: 'Atlas',
      entities: [],
      sensitive: over['sensitive'] as boolean | undefined,
      validFrom: over['validFrom'] as Date | undefined,
    });

  /** Insert a genuinely-signed confirmed deletion receipt for `owner`. */
  const seedReceipt = async (owner: string): Promise<string> => {
    const signer = await loadInstanceSigner(keyDir);
    const id = randomUUID();
    const payload = {
      id,
      source_type: 'user_note',
      source_id: randomUUID(),
      counts_json: {
        requested_by: owner,
        enumerated_at: '2026-06-30T12:00:00.000Z',
        memory_count: 1,
        object_keys: [],
      },
      signed_at: '2026-06-30T12:00:03.000Z',
      confirmed_at: '2026-06-30T12:00:03.000Z',
      prev_hash: GENESIS_HASH,
    };
    const hash = sha256Hex(Buffer.from(canonicalize(payload), 'utf8'));
    const signature = signer.sign(hash);
    await tdb.pool.query(
      `INSERT INTO deletion_receipt
         (id, source_type, source_id, status, counts_json, prev_hash, hash, signature, signed_at, confirmed_at)
       VALUES ($1,$2,$3,'confirmed',$4,$5,$6,$7,$8,$9)`,
      [
        id,
        payload.source_type,
        payload.source_id,
        JSON.stringify(payload.counts_json),
        payload.prev_hash,
        hash,
        signature,
        payload.signed_at,
        payload.confirmed_at,
      ],
    );
    return id;
  };

  const createExport = (owner: string, orgId = 'org-passport') =>
    tdb.db.transaction((tx) => passportStore.createInTx(tx, owner, orgId, false));

  const runAndOpen = async (owner: string, orgId = 'org-passport') => {
    const request = await createExport(owner, orgId);
    const { objectKey } = await executor.run(request.id, new Date('2026-07-14T12:00:00.000Z'));
    const object = await objects.getObject(objectKey);
    const entries = new Map(readZip(object.body).map((e) => [e.path, e.data]));
    return {
      memories: JSON.parse(entries.get(PASSPORT_PATHS.memories)!.toString()),
      tasks: JSON.parse(entries.get(PASSPORT_PATHS.tasks)!.toString()),
      receipts: JSON.parse(entries.get(PASSPORT_PATHS.receipts)!.toString()),
      manifest: JSON.parse(entries.get(PASSPORT_PATHS.manifest)!.toString()),
    };
  };

  it('passport_completeness: every memory, its history + chain, tasks and receipts are present', async () => {
    const owner = `pp-complete-${randomUUID()}`;
    const v1 = await seed(owner, 'Atlas costs 100 EUR.', { validFrom: new Date('2026-01-01') });
    const { successor: v2 } = await store.supersede({ kind: 'user', userId: owner }, v1.id, {
      content: 'Atlas costs 120 EUR.',
      scope: 'private',
      sourceType: 'user_note',
      sourceId: randomUUID(),
      subjectEntity: 'Atlas',
      entities: [],
      validFrom: new Date('2026-04-01'),
    });
    const shared = await seed(owner, 'Atlas is shared org-wide.', { scope: 'shared' });
    const sensitive = await seed(owner, 'Atlas secret discount.', { sensitive: true });
    // A task derived from v2, and a confirmed receipt.
    await tdb.pool.query(
      `INSERT INTO task (owner_id, scope, derived_from_memory_id, title, status) VALUES ($1,'private',$2,$3,'open')`,
      [owner, v2.id, 'Send the Atlas quote'],
    );
    const receiptId = await seedReceipt(owner);

    const out = await runAndOpen(owner);
    const ids = new Set(out.memories.memories.map((m: { id: string }) => m.id));
    // Every version, including the REPLACED predecessor (the full history).
    for (const id of [v1.id, v2.id, shared.id, sensitive.id]) expect(ids.has(id)).toBe(true);
    const v1Doc = out.memories.memories.find((m: { id: string }) => m.id === v1.id);
    expect(v1Doc.status).toBe('replaced');
    expect(v1Doc.superseded_by).toBe(v2.id); // the supersession chain
    expect(out.memories.count).toBe(out.memories.memories.length);

    expect(out.tasks.tasks.map((t: { title: string }) => t.title)).toContain(
      'Send the Atlas quote',
    );
    expect(out.receipts.receipts.map((r: { id: string }) => r.id)).toContain(receiptId);
    // The exported receipt still verifies against its chain and the included key.
    expect(
      verifyChain(out.receipts.receipts as ConfirmedReceipt[], out.receipts.instance_public_key_pem)
        .ok,
    ).toBe(true);
  });

  it('passport_gating: another user’s private/sensitive never leaks; shared + sensitive handled per the record', async () => {
    const me = `pp-gate-me-${randomUUID()}`;
    const other = `pp-gate-other-${randomUUID()}`;
    const mySensitive = await seed(me, 'My sensitive fact.', { sensitive: true });
    const myShared = await seed(me, 'My shared fact.', { scope: 'shared' });
    const theirPrivate = await seed(other, 'Their private fact.');
    const theirSensitive = await seed(other, 'Their sensitive fact.', { sensitive: true });
    const theirShared = await seed(other, 'Their shared fact.', { scope: 'shared' });
    const theirSharedSensitive = await seed(other, 'Their shared BUT sensitive fact.', {
      scope: 'shared',
      sensitive: true,
    });

    const out = await runAndOpen(me);
    const byId = new Map<string, { sensitive: boolean; owned_by_me: boolean }>(
      out.memories.memories.map((m: { id: string; sensitive: boolean; owned_by_me: boolean }) => [
        m.id,
        m,
      ]),
    );

    // Never another user's private or sensitive data.
    expect(byId.has(theirPrivate.id)).toBe(false);
    expect(byId.has(theirSensitive.id)).toBe(false);
    expect(byId.has(theirSharedSensitive.id)).toBe(false); // sensitive gate is owner-only, even shared

    // Own sensitive: included and marked; own shared: included, owned_by_me.
    expect(byId.get(mySensitive.id)).toMatchObject({ sensitive: true, owned_by_me: true });
    expect(byId.get(myShared.id)).toMatchObject({ owned_by_me: true });
    // Legitimately-visible shared data from a teammate: included, marked not mine.
    // (Cross-org isolation is the single-tenant DEPLOYMENT boundary, decision
    // 0019: another org is another instance with another database — not a query
    // gate, so it is total by construction and not exercised here.)
    expect(byId.get(theirShared.id)).toMatchObject({ owned_by_me: false });
  });
});
