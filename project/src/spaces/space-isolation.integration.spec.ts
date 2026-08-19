import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@cogeto/shared';
import { fakeEmbedding, startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { createMemoryStore } from '../memory/index';
import type { MemoryRow, MemoryStore } from '../memory/index';

const DIMS = 8;

/**
 * Cross-space isolation at the data layer (docs/features/spaces.md): material
 * created in one space is invisible from another through every read
 * primitive, FOR THE SAME USER, including the vector path. The same-user case
 * is the one a reasonable implementation gets wrong, because owner and scope
 * both pass and only the space dimension stands between the caller and the
 * row. The two spaces hold the SAME content on purpose: identical text,
 * identical embedding, identical owner, so nothing but the gate's space
 * condition can tell them apart.
 */
describe('space isolation (integration: real Postgres + Qdrant)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;

  const SPACE_B = randomUUID();
  const user: Principal = {
    userId: 'user-iso',
    name: 'User',
    email: null,
    orgId: 'org-1',
    orgName: 'Org',
    roles: [],
  };
  /** The same user, standing in space B. */
  const userInB: Principal = { ...user, spaceId: SPACE_B };
  const peer: Principal = { ...user, userId: 'peer-iso', name: 'Peer' };
  const peerInB: Principal = { ...peer, spaceId: SPACE_B };

  let inDefault: MemoryRow;
  let inB: MemoryRow;
  let sharedInB: MemoryRow;

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    store = createMemoryStore({
      db: tdb.db,
      qdrant: {
        url: qdrant.url,
        embeddingModel: 'test-embed',
        dimensions: DIMS,
        collection: 'space-isolation-test',
      },
    });
    await store.ensureIndexReady();

    await tdb.pool.query('INSERT INTO space (id, name) VALUES ($1, $2)', [SPACE_B, 'Sealed B']);

    const fact = (sourceId: string) => ({
      content: 'Alice committed to the tea delivery',
      scope: 'private' as const,
      sourceType: 'user_note' as const,
      sourceId,
      entities: ['Alice'],
      subjectEntity: 'Alice',
      kind: 'commitment' as const,
      authoredByUser: true,
    });
    inDefault = await store.createFromFact(user, fact(randomUUID()));
    inB = await store.createFromFact(userInB, fact(randomUUID()));
    // A peer's SHARED fact in space B: shared crosses owners, never spaces.
    sharedInB = await store.createFromFact(peerInB, {
      ...fact(randomUUID()),
      scope: 'shared' as const,
    });
    const rows = [inDefault, inB, sharedInB];
    await store.upsertVectors(
      rows,
      rows.map((r) => fakeEmbedding(r.content ?? r.id, DIMS)),
    );
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  it('rows_are_stamped: each fact carries the space it was captured in', () => {
    expect(inDefault.spaceId).not.toBe(SPACE_B);
    expect(inB.spaceId).toBe(SPACE_B);
  });

  it('get_by_id_is_sealed: the same user cannot read the other space even by identifier', async () => {
    expect(await store.getForPrincipal(user, inB.id)).toBeNull();
    expect(await store.getForPrincipal(userInB, inDefault.id)).toBeNull();
    expect((await store.getForPrincipal(userInB, inB.id))?.id).toBe(inB.id);
  });

  it('lists_and_counts_are_sealed: list, export listing and status counts see one space', async () => {
    expect((await store.listForPrincipal(user)).map((r) => r.id)).toEqual([inDefault.id]);
    const bIds = (await store.listForPrincipal(userInB)).map((r) => r.id);
    expect(bIds).toContain(inB.id);
    expect(bIds).not.toContain(inDefault.id);
    expect((await store.listAllForPrincipal(user)).map((r) => r.id)).toEqual([inDefault.id]);
    expect(await store.countForPrincipal(user)).toBe(1);
    const statuses = await store.statusCountsForPrincipal(user);
    expect(statuses.active).toBe(1);
  });

  it('search_signals_are_sealed: full text, entity, subject and the timeline subject read', async () => {
    const fts = await store.ftsSearch(user, 'tea delivery', { topK: 10 });
    expect(fts.map((h) => h.memory.id)).toEqual([inDefault.id]);
    const entity = await store.entitySearch(user, ['Alice'], { topK: 10 });
    expect(entity.map((h) => h.memory.id)).toEqual([inDefault.id]);
    const subject = await store.subjectSearch(user, ['Alice'], { topK: 10 });
    expect(subject.map((r) => r.id)).toEqual([inDefault.id]);
    const timeline = await store.listForSubject(user, 'Alice');
    expect(timeline.map((r) => r.id)).toEqual([inDefault.id]);
  });

  it('vector_path_is_sealed: identical embeddings, the payload pre-filter alone separates them', async () => {
    const query = fakeEmbedding(inB.content ?? '', DIMS);
    const fromDefault = await store.vectorSearch(user, query, { topK: 10 });
    expect(fromDefault.map((h) => h.memoryId)).toEqual([inDefault.id]);
    const fromB = await store.vectorSearch(userInB, query, { topK: 10 });
    expect(fromB.map((h) => h.memoryId).sort()).toEqual([inB.id, sharedInB.id].sort());
    // The row resolution behind vector hits is the belt behind the filter.
    const resolved = await store.getManyForPrincipal(user, [inB.id, sharedInB.id]);
    expect(resolved).toEqual([]);
  });

  it('shared_crosses_owners_never_spaces: a peer sees the shared fact only inside its space', async () => {
    const sharedSeenInB = (await store.listForPrincipal(userInB)).map((r) => r.id);
    expect(sharedSeenInB).toContain(sharedInB.id);
    const sharedSeenInDefault = (await store.listForPrincipal(user)).map((r) => r.id);
    expect(sharedSeenInDefault).not.toContain(sharedInB.id);
  });

  it('open_loops_and_source_refs_are_sealed: the attention reads see one space', async () => {
    expect((await store.openLoopsForPrincipal(user)).map((r) => r.id)).toEqual([inDefault.id]);
    const refs = await store.listSourceRefsForPrincipal(user);
    expect(refs.map((r) => r.sourceId)).toEqual([inDefault.sourceId]);
  });

  it('temporal_read_is_sealed: point in time honours the space like every read', async () => {
    const hits = await store.pointInTime(user, new Date(), { topK: 10 });
    expect(hits.map((h) => h.memory.id)).toEqual([inDefault.id]);
  });
});
