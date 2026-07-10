import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { MemoryStore } from './memory.store';
import type { NewFact } from './memory.store';
import { MemoryVectorStore } from './persistence/vector-store';

const userA: Principal = {
  userId: 'user-a',
  name: 'User A',
  email: null,
  orgId: 'org-1',
  orgName: 'Org',
  roles: [],
};
const userB: Principal = { ...userA, userId: 'user-b', name: 'User B' };

const fact = (overrides: Partial<NewFact> = {}): NewFact => ({
  content: 'Ana will send the proposal to Marko',
  scope: 'private',
  sourceType: 'user_note',
  sourceId: `note-${Math.random().toString(36).slice(2)}`,
  ...overrides,
});

describe('memory store (integration, real Postgres + Qdrant)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;

  beforeAll(async () => {
    // Real Qdrant since QS-26: transitions and supersession REQUIRE the vector
    // store (their payload sync throws on a vector-less store, by design).
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    const vectors = new MemoryVectorStore({
      url: qdrant.url,
      embeddingModel: 'test-embed',
      dimensions: 8,
      collection: 'memory-spec',
    });
    await vectors.ensureCollection();
    store = new MemoryStore(tdb.db, vectors);
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  it('vectorless_transition_throws (QS-26): a store without Qdrant refuses transitions and supersession instead of silently skipping the payload sync', async () => {
    const sqlOnlyStore = new MemoryStore(tdb.db);
    const row = await sqlOnlyStore.createFromFact(userA, fact()); // plain insert: allowed
    await expect(
      sqlOnlyStore.transition({ kind: 'reconciliation' }, row.id, 'contradicted'),
    ).rejects.toThrow(/vector store/);
    await expect(
      sqlOnlyStore.supersede({ kind: 'user', userId: userA.userId }, row.id, fact()),
    ).rejects.toThrow(/vector store/);
    // Nothing changed: the row is untouched and still active.
    expect((await sqlOnlyStore.getForPrincipal(userA, row.id))?.status).toBe('active');
  });

  it("scope_gate: user B's private memory is never returned to user A through any public read", async () => {
    const bPrivate = await store.createFromFact(userB, fact({ content: 'B private secret' }));
    const bShared = await store.createFromFact(
      userB,
      fact({ content: 'B shared decision', scope: 'shared' }),
    );

    // Direct get by id: not found for A, even knowing the id.
    expect(await store.getForPrincipal(userA, bPrivate.id)).toBeNull();
    // Broad list: A sees B's shared memory, never B's private one.
    const aSees = await store.listForPrincipal(userA, { limit: 200 });
    const ids = aSees.map((m) => m.id);
    expect(ids).not.toContain(bPrivate.id);
    expect(ids).toContain(bShared.id);
    // The owner still sees their own private row.
    expect((await store.getForPrincipal(userB, bPrivate.id))?.id).toBe(bPrivate.id);
  });

  it('sensitive_gate: excluded by default, owner-only even with opt-in', async () => {
    const bSensitiveShared = await store.createFromFact(
      userB,
      fact({ content: 'B sensitive but shared-scope', scope: 'shared', sensitive: true }),
    );

    // Default: even the owner does not get sensitive rows without opt-in.
    expect(await store.getForPrincipal(userB, bSensitiveShared.id)).toBeNull();
    const bDefaultList = await store.listForPrincipal(userB, { limit: 200 });
    expect(bDefaultList.map((m) => m.id)).not.toContain(bSensitiveShared.id);

    // Owner with explicit opt-in: returned.
    expect(
      (await store.getForPrincipal(userB, bSensitiveShared.id, { includeSensitive: true }))?.id,
    ).toBe(bSensitiveShared.id);

    // Non-owner with opt-in: still gated — shared scope does NOT override sensitive.
    expect(
      await store.getForPrincipal(userA, bSensitiveShared.id, { includeSensitive: true }),
    ).toBeNull();
    const aOptInList = await store.listForPrincipal(userA, { includeSensitive: true, limit: 200 });
    expect(aOptInList.map((m) => m.id)).not.toContain(bSensitiveShared.id);
  });

  it('provenance_always: a memory cannot be created without source_type/source_id', async () => {
    const before = await tdb.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM memory');

    // The aggregate rejects orphans on every write path — including empty
    // strings, which the database's NOT NULL columns alone would accept.
    await expect(store.createFromFact(userA, fact({ sourceId: '' }))).rejects.toThrow(
      /source_type and source_id/,
    );
    await expect(store.createFromFact(userA, fact({ sourceId: '   ' }))).rejects.toThrow(
      /source_type and source_id/,
    );
    await expect(
      store.createFromFact(userA, fact({ sourceType: undefined as never })),
    ).rejects.toThrow(/source_type and source_id/);
    await expect(
      tdb.db.transaction((tx) =>
        store.admitExtractedFact(tx, userA.userId, fact({ sourceId: '' })),
      ),
    ).rejects.toThrow(/source_type and source_id/);
    await expect(
      tdb.db.transaction((tx) => store.admitExtractedFact(tx, '', fact())),
    ).rejects.toThrow(/source_type and source_id/);

    const after = await tdb.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM memory');
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it('illegal_transition: actor-owned transitions are rejected; supersession preserves history', async () => {
    const row = await store.createFromFact(userA, fact({ content: 'March pricing is 100' }));

    // A user may not set contradicted (reconciliation-owned).
    await expect(
      store.transition({ kind: 'user', userId: userA.userId }, row.id, 'contradicted'),
    ).rejects.toThrow(/illegal transition/);
    // The system (verification) may not set user_approved (user-owned).
    await expect(
      store.transition({ kind: 'verification' }, row.id, 'user_approved'),
    ).rejects.toThrow(/illegal transition/);
    // replaced is unreachable via transition, even for reconciliation.
    await expect(store.transition({ kind: 'reconciliation' }, row.id, 'replaced')).rejects.toThrow(
      /supersession/,
    );
    // A user may not transition someone else's memory (reported as not-found).
    await expect(
      store.transition({ kind: 'user', userId: userB.userId }, row.id, 'user_approved'),
    ).rejects.toThrow(/not found/);

    // Legal path: reconciliation contradicts, the user re-affirms their own row
    // by setting it back to active (S3-B: user_approved is reserved for the
    // uncertain→approved review verdict).
    await store.transition({ kind: 'reconciliation' }, row.id, 'contradicted', 'conflicting note');
    const reaffirmed = await store.transition(
      { kind: 'user', userId: userA.userId },
      row.id,
      'active',
    );
    expect(reaffirmed.status).toBe('active');

    // Supersession: predecessor kept, interval closed, pointer set — never deleted.
    const validFrom = new Date('2026-07-01T00:00:00Z');
    const { predecessor, successor } = await store.supersede(
      { kind: 'user', userId: userA.userId },
      row.id,
      fact({ content: 'July pricing is 120', validFrom }),
    );
    expect(predecessor.status).toBe('replaced');
    expect(predecessor.supersededBy).toBe(successor.id);
    expect(predecessor.validUntil?.toISOString()).toBe(validFrom.toISOString());
    expect((await store.getForPrincipal(userA, row.id))?.status).toBe('replaced');

    // Terminal: the replaced row never transitions again.
    await expect(
      store.transition({ kind: 'reconciliation' }, row.id, 'contradicted'),
    ).rejects.toThrow(/terminal/);

    // Every transition wrote an audit row, and audit_log is append-only.
    const audits = await tdb.pool.query(
      "SELECT action FROM audit_log WHERE entity_id = $1 AND entity_type = 'memory'",
      [row.id],
    );
    const actions = audits.rows.map((r: { action: string }) => r.action);
    expect(actions.filter((a) => a === 'memory.status_transition')).toHaveLength(2);
    expect(actions).toContain('memory.superseded');
    await expect(tdb.pool.query("UPDATE audit_log SET action = 'tampered'")).rejects.toThrow(
      /append-only/,
    );
    await expect(tdb.pool.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
  });
});
