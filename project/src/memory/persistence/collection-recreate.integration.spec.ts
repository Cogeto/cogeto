import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestQdrant } from '../../testing/index';
import type { TestQdrant } from '../../testing/index';
import { MemoryVectorStore } from './vector-store';

/**
 * reindex_recreates_collection_on_dimension_change (issue #179): switching to
 * an embeddings model with a different vector size must let reindex DROP and
 * recreate the collection — otherwise every upsert fails with a dimension
 * error. Normal boot (no flag) keeps create-if-missing semantics.
 */
describe('reindex_recreates_collection_on_dimension_change', () => {
  let qdrant: TestQdrant;
  const COLLECTION = 'dim-change-spec';

  const size = async (): Promise<number> => {
    const res = await fetch(`${qdrant.url}/collections/${COLLECTION}`);
    const body = (await res.json()) as {
      result?: { config?: { params?: { vectors?: { size?: number } } } };
    };
    return body.result?.config?.params?.vectors?.size ?? -1;
  };

  beforeAll(async () => {
    qdrant = await startTestQdrant();
  });
  afterAll(async () => {
    await qdrant.stop();
  });

  it('recreates on mismatch only when reindex asks; boot semantics stay create-if-missing', async () => {
    const oldStore = new MemoryVectorStore({
      url: qdrant.url,
      embeddingModel: 'old-embed',
      dimensions: 8,
      collection: COLLECTION,
    });
    await oldStore.ensureCollection();
    expect(await size()).toBe(8);

    const newStore = new MemoryVectorStore({
      url: qdrant.url,
      embeddingModel: 'new-embed',
      dimensions: 16,
      collection: COLLECTION,
    });

    // Boot path: create-if-missing only — the old collection is untouched.
    await newStore.ensureCollection();
    expect(await size()).toBe(8);

    // Reindex path: mismatch → drop + recreate at the new size, and the new
    // space accepts upserts (the #179 failure was exactly here).
    await newStore.ensureCollection({ recreateOnDimensionMismatch: true });
    expect(await size()).toBe(16);
    await newStore.upsert([
      {
        id: '00000000-0000-4000-8000-000000000001',
        vector: Array.from({ length: 16 }, () => 0.1),
        payload: {
          owner_id: 'user-a',
          scope: 'private',
          status: 'active',
          sensitive: false,
          source_type: 'user_note',
          source_id: 'note-1',
          valid_until: null,
        },
      },
    ]);

    // Idempotent when the size already matches: no drop, the point survives.
    await newStore.ensureCollection({ recreateOnDimensionMismatch: true });
    expect(await size()).toBe(16);
  });
});
