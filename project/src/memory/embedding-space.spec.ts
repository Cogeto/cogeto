import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { MemoryStore } from './memory.store';
import { listForeignEmbeddingModels } from './embedding-space';
import { memory } from './persistence/tables';

const owner: Principal = {
  userId: 'user-a',
  name: 'User A',
  email: null,
  orgId: 'org-1',
  orgName: 'Org',
  roles: [],
};

/**
 * embed_change_requires_reindex (decision 0040 ruling 3): the boot guard's
 * query — stored vectors from a different embeddings model than the active one
 * are reported (→ the app/worker refuse to start until reindex); rows embedded
 * with the active model or not yet embedded never block.
 */
describe('embed_change_requires_reindex', () => {
  let tdb: TestDatabase;
  let store: MemoryStore;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    store = new MemoryStore(tdb.db);
  });
  afterAll(async () => {
    await tdb.stop();
  });

  it('reports foreign embedding models and stays quiet when spaces match', async () => {
    const a = await store.createFromFact(owner, {
      content: 'embedded with the old model',
      scope: 'private',
      sourceType: 'user_note',
      sourceId: 'note-embed-1',
    });
    const b = await store.createFromFact(owner, {
      content: 'embedded with the active model',
      scope: 'private',
      sourceType: 'user_note',
      sourceId: 'note-embed-2',
    });
    // A third row that was never embedded (recall-only) must never block.
    await store.createFromFact(owner, {
      content: 'not yet embedded',
      scope: 'private',
      sourceType: 'user_note',
      sourceId: 'note-embed-3',
    });
    await tdb.db.update(memory).set({ embeddingModel: 'old-embed' }).where(eq(memory.id, a.id));
    await tdb.db.update(memory).set({ embeddingModel: 'active-embed' }).where(eq(memory.id, b.id));

    // Active model differs from a stored one → the guard reports it (refuse).
    expect(await listForeignEmbeddingModels(tdb.db, 'active-embed')).toEqual(['old-embed']);

    // After "reindex" (re-embedding under the active model) the guard is quiet.
    await tdb.db.update(memory).set({ embeddingModel: 'active-embed' }).where(eq(memory.id, a.id));
    expect(await listForeignEmbeddingModels(tdb.db, 'active-embed')).toEqual([]);
  });
});
