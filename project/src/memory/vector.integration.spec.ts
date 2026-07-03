import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@cogeto/shared';
import { fakeEmbedding, startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { ModelGateway } from '../model-gateway/index';
import { MemoryStore } from './memory.store';
import type { NewFact } from './memory.store';
import { buildGateFilter, MemoryVectorStore } from './persistence/vector-store';
import { reindexMemories } from './reindex';

const DIMS = 8;
const MODEL = 'test-embed';
const COLLECTION = 'memories';

const userA: Principal = {
  userId: 'user-a',
  name: 'User A',
  email: null,
  orgId: 'org-1',
  orgName: 'Org',
  roles: [],
};
const userB: Principal = { ...userA, userId: 'user-b', name: 'User B' };

/** Deterministic embeddings — reindex must reproduce the exact same vectors. */
class FakeEmbedGateway extends ModelGateway {
  embedCalls = 0;
  complete(): never {
    throw new Error('not used');
  }
  // eslint-disable-next-line require-yield -- not used
  async *completeStream(): AsyncIterable<string> {
    throw new Error('not used');
  }
  extractStructured<T>(): Promise<T> {
    throw new Error('not used');
  }
  async embed(texts: string[]): Promise<number[][]> {
    this.embedCalls += texts.length;
    return texts.map((text) => fakeEmbedding(text, DIMS));
  }
  embeddingModelId(): string {
    return MODEL;
  }
}

describe('memory vector index (integration, real Postgres + real Qdrant)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let vectors: MemoryVectorStore;
  let store: MemoryStore;
  const gateway = new FakeEmbedGateway();

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    vectors = new MemoryVectorStore({
      url: qdrant.url,
      embeddingModel: MODEL,
      dimensions: DIMS,
      collection: COLLECTION,
    });
    store = new MemoryStore(tdb.db, vectors);
    await store.ensureIndexReady();
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  const fact = (content: string, overrides: Partial<NewFact> = {}): NewFact => ({
    content,
    scope: 'private',
    sourceType: 'user_note',
    sourceId: `note-${Math.random().toString(36).slice(2)}`,
    embeddingModel: MODEL,
    ...overrides,
  });

  const insertIndexed = async (principal: Principal, newFact: NewFact) => {
    const row = await store.createFromFact(principal, newFact);
    await store.upsertVectors([row], [fakeEmbedding(row.content as string, DIMS)]);
    return row;
  };

  it('vector_search_gated: B private and sensitive points never reach A — native Qdrant filters', async () => {
    // The filter itself first: gates must be IN the query (§A.4), and the
    // opt-in variant still restricts sensitive rows to the caller's own.
    expect(buildGateFilter(userA, {})).toEqual({
      must: [
        {
          should: [
            { key: 'owner_id', match: { value: 'user-a' } },
            { key: 'scope', match: { value: 'shared' } },
          ],
        },
        { key: 'sensitive', match: { value: false } },
      ],
    });
    expect(buildGateFilter(userA, { includeSensitive: true })).toEqual({
      must: [
        {
          should: [
            { key: 'owner_id', match: { value: 'user-a' } },
            { key: 'scope', match: { value: 'shared' } },
          ],
        },
        {
          should: [
            { key: 'sensitive', match: { value: false } },
            { key: 'owner_id', match: { value: 'user-a' } },
          ],
        },
      ],
    });

    // Behavior: give every row the SAME content (= same vector), so an
    // unfiltered search would return them all — only the gates separate them.
    const content = 'Ana will send the revised proposal to Luka';
    const aPrivate = await insertIndexed(userA, fact(content));
    const bPrivate = await insertIndexed(userB, fact(content));
    const bShared = await insertIndexed(userB, fact(content, { scope: 'shared' }));
    const bSensitiveShared = await insertIndexed(
      userB,
      fact(content, { scope: 'shared', sensitive: true }),
    );

    const query = fakeEmbedding(content, DIMS);
    const idsFor = async (principal: Principal, includeSensitive?: boolean) =>
      (await store.vectorSearch(principal, query, { topK: 10, includeSensitive })).map(
        (hit) => hit.memoryId,
      );

    const aDefault = await idsFor(userA);
    expect(aDefault).toContain(aPrivate.id);
    expect(aDefault).toContain(bShared.id);
    expect(aDefault).not.toContain(bPrivate.id);
    expect(aDefault).not.toContain(bSensitiveShared.id);

    // A opting in to sensitive still only unlocks A's OWN sensitive rows.
    const aOptIn = await idsFor(userA, true);
    expect(aOptIn).not.toContain(bPrivate.id);
    expect(aOptIn).not.toContain(bSensitiveShared.id);

    // B without opt-in does not see their own sensitive row; with opt-in they do.
    expect(await idsFor(userB)).not.toContain(bSensitiveShared.id);
    expect(await idsFor(userB, true)).toContain(bSensitiveShared.id);

    // Scores are normalized to [0,1].
    for (const hit of await store.vectorSearch(userA, query, { topK: 10 })) {
      expect(hit.score).toBeGreaterThanOrEqual(0);
      expect(hit.score).toBeLessThanOrEqual(1);
    }
  });

  it('reindex_faithful: wipe the collection, reindex from Postgres, identical search results', async () => {
    // Distinctive extra rows so the search result set is non-trivial.
    await insertIndexed(userA, fact('The Meridian NDA is still unsigned'));
    await insertIndexed(userA, fact('Kickoff with Arkona is on July 20 in Rijeka'));

    const query = fakeEmbedding('The Meridian NDA is still unsigned', DIMS);
    const before = await store.vectorSearch(userA, query, { topK: 10 });
    expect(before.length).toBeGreaterThan(0);

    // Disaster: the whole collection is gone. Postgres is the source of truth.
    await vectors.deleteCollectionIfExists();

    const report = await reindexMemories({
      db: tdb.db,
      gateway,
      qdrantUrl: qdrant.url,
      dimensions: DIMS,
      collection: COLLECTION,
      batchSize: 3, // force multiple keyset pages
    });
    expect(report.ok).toBe(true);
    expect(report.pointCount).toBe(report.embeddable);
    expect(report.reembedded).toBe(report.embeddable); // wiped → everything re-embedded
    expect(report.reused).toBe(0);

    // Identical hits and scores (sorted by id: equal-score ties have no
    // guaranteed order across a rebuild).
    const byId = (hits: { memoryId: string; score: number }[]) =>
      [...hits].sort((a, b) => a.memoryId.localeCompare(b.memoryId));
    const after = await store.vectorSearch(userA, query, { topK: 10 });
    expect(byId(after)).toEqual(byId(before));

    // Second run, nothing wiped: same model + points present → all reused.
    const callsBefore = gateway.embedCalls;
    const second = await reindexMemories({
      db: tdb.db,
      gateway,
      qdrantUrl: qdrant.url,
      dimensions: DIMS,
      collection: COLLECTION,
    });
    expect(second.ok).toBe(true);
    expect(second.reembedded).toBe(0);
    expect(second.reused).toBe(second.embeddable);
    expect(gateway.embedCalls).toBe(callsBefore); // re-embeds ONLY when required

    // Model change: mark one row as embedded with an older model → exactly
    // one re-embed on the next run.
    await tdb.pool.query(
      `UPDATE memory SET embedding_model = 'old-embed' WHERE id = (SELECT id FROM memory LIMIT 1)`,
    );
    const third = await reindexMemories({
      db: tdb.db,
      gateway,
      qdrantUrl: qdrant.url,
      dimensions: DIMS,
      collection: COLLECTION,
    });
    expect(third.ok).toBe(true);
    expect(third.reembedded).toBe(1);
    expect(third.reused).toBe(third.embeddable - 1);
  });
});
