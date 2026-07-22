import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@cogeto/shared';
import { fakeEmbedding, startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { ModelGateway } from '../model-gateway/index';
import { MemoryStore } from './memory.store';
import type { NewFact } from './memory.store';
import { vectorIndexDimensionMismatch } from './embedding-space';
import { dimensionsFor, MemoryVectorStore } from './persistence/vector-store';
import { reindexMemories } from './reindex';

/**
 * Local embeddings via the reindex flow (decision 0041 ruling 5; issue #182):
 * switching the embeddings model to bge-m3 recreates the collection at the new
 * model's dimension and re-embeds everything from Postgres; while the index
 * and configuration disagree the dimension guard reports the mismatch (boot
 * refuses on it); and an interrupted reindex resumes to a complete, gap-free,
 * duplicate-free index.
 */

const HOSTED_MODEL = 'text-embedding-3-small'; // 1536
const LOCAL_MODEL = 'bge-m3'; // 1024
const COLLECTION = 'memories';

const user: Principal = {
  userId: 'user-a',
  name: 'User A',
  email: null,
  orgId: 'org-1',
  orgName: 'Org',
  roles: [],
};

/** Deterministic per-model embeddings; optionally fails after N batch calls. */
class FakeEmbedGateway extends ModelGateway {
  embedBatches = 0;
  constructor(
    private readonly model: string,
    private readonly failAfterBatches = Infinity,
  ) {
    super();
  }
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
    if (texts.length > 0 && ++this.embedBatches > this.failAfterBatches) {
      throw new Error('local runtime went away mid-reindex');
    }
    return texts.map((text) => fakeEmbedding(text, dimensionsFor(this.model)));
  }
  embeddingModelId(): string {
    return this.model;
  }
}

describe('local embeddings with reindex (integration, real Postgres + real Qdrant)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  const storeFor = (model: string): { vectors: MemoryVectorStore; store: MemoryStore } => {
    const vectors = new MemoryVectorStore({
      url: qdrant.url,
      embeddingModel: model,
      collection: COLLECTION,
    });
    return { vectors, store: new MemoryStore(tdb.db, vectors) };
  };

  const collectionSize = async (): Promise<number> => {
    const res = await fetch(`${qdrant.url}/collections/${COLLECTION}`);
    const body = (await res.json()) as {
      result?: { config?: { params?: { vectors?: { size?: number } } } };
    };
    return body.result?.config?.params?.vectors?.size ?? -1;
  };

  const fact = (content: string): NewFact => ({
    content,
    scope: 'private',
    sourceType: 'user_note',
    sourceId: `note-${Math.random().toString(36).slice(2)}`,
    embeddingModel: HOSTED_MODEL,
  });

  it('embed_dimension_switch: bge-m3 recreates at 1024, reindex repopulates, search works; the mismatch state is detected', async () => {
    // Hosted starting point: three memories embedded at 1536.
    const hosted = storeFor(HOSTED_MODEL);
    await hosted.store.ensureIndexReady();
    const contents = [
      'Ana confirmed the mapping format on 14 July',
      'The Meridian NDA is still unsigned',
      'Kickoff with Arkona is on July 20 in Rijeka',
    ];
    for (const content of contents) {
      const row = await hosted.store.createFromFact(user, fact(content));
      await hosted.store.upsertVectors([row], [fakeEmbedding(content, 1536)]);
    }
    expect(await collectionSize()).toBe(1536);
    expect(
      await vectorIndexDimensionMismatch({ url: qdrant.url, embeddingModel: HOSTED_MODEL }),
    ).toBeNull();

    // Configuration switched to bge-m3, index not yet rebuilt: the dimension
    // guard reports the disagreement EXPLICITLY (boot refuses on it) — a
    // model-name check alone could not see this collection-level state.
    expect(
      await vectorIndexDimensionMismatch({ url: qdrant.url, embeddingModel: LOCAL_MODEL }),
    ).toEqual({ expected: 1024, actual: 1536 });

    // The way out: reindex recreates the collection at 1024 and re-embeds
    // everything from Postgres — the §A.4 source-of-truth rebuild.
    const progress: string[] = [];
    const report = await reindexMemories({
      db: tdb.db,
      gateway: new FakeEmbedGateway(LOCAL_MODEL),
      qdrantUrl: qdrant.url,
      embeddingModel: LOCAL_MODEL,
      log: (message) => progress.push(message),
    });
    expect(report.ok).toBe(true);
    expect(report.reembedded).toBe(report.embeddable);
    expect(await collectionSize()).toBe(1024);
    expect(progress.join('\n')).toMatch(/progress \d+\/3/); // done/total reporting
    expect(
      await vectorIndexDimensionMismatch({ url: qdrant.url, embeddingModel: LOCAL_MODEL }),
    ).toBeNull();

    // Search works in the new space, through the gates as always.
    const local = storeFor(LOCAL_MODEL);
    const hits = await local.store.vectorSearch(user, fakeEmbedding(contents[1]!, 1024), {
      topK: 5,
    });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('reindex_resumable: an interrupted run resumes to completion without duplicates or gaps', async () => {
    // Grow the corpus, then switch back to the hosted model with a gateway
    // that dies after the first batch — a realistic mid-reindex interruption.
    const local = storeFor(LOCAL_MODEL);
    for (let i = 0; i < 4; i++) {
      const row = await local.store.createFromFact(user, {
        ...fact(`Follow-up item number ${i} for the resumability corpus`),
        embeddingModel: LOCAL_MODEL,
      });
      await local.store.upsertVectors([row], [fakeEmbedding(row.content as string, 1024)]);
    }

    const flaky = new FakeEmbedGateway(HOSTED_MODEL, 1);
    await expect(
      reindexMemories({
        db: tdb.db,
        gateway: flaky,
        qdrantUrl: qdrant.url,
        embeddingModel: HOSTED_MODEL,
        batchSize: 2,
      }),
    ).rejects.toThrow(/went away mid-reindex/);

    // Resume with the runtime back: rows already re-embedded and stamped are
    // reused; the rest are embedded; the final index is exact.
    const resumed = await reindexMemories({
      db: tdb.db,
      gateway: new FakeEmbedGateway(HOSTED_MODEL),
      qdrantUrl: qdrant.url,
      embeddingModel: HOSTED_MODEL,
      batchSize: 2,
    });
    expect(resumed.ok).toBe(true);
    expect(resumed.reused).toBe(2); // exactly the batch the interrupted run finished
    expect(resumed.reembedded).toBe(resumed.embeddable - 2);
    expect(resumed.pointCount).toBe(resumed.embeddable); // no duplicates, no gaps

    // Every row is stamped with the active model — nothing mixed left behind.
    const { rows } = await tdb.pool.query<{ embedding_model: string }>(
      `SELECT DISTINCT embedding_model FROM memory WHERE embedding_model IS NOT NULL`,
    );
    expect(rows.map((r) => r.embedding_model)).toEqual([HOSTED_MODEL]);
  });
});
