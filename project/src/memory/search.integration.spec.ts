import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { MemoryStore } from './memory.store';
import type { NewFact } from './memory.store';

/**
 * fts_gated / entity_gated: the S3-A named tests. Pure Postgres — the gates
 * are WHERE clauses inside the primitives' SQL, so the assertions run against
 * real seeded data, no Qdrant involved.
 */

const userA: Principal = {
  userId: 'user-a',
  name: 'User A',
  email: null,
  orgId: 'org-1',
  orgName: 'Org',
  roles: [],
};
const userB: Principal = { ...userA, userId: 'user-b', name: 'User B' };

describe('memory search primitives (integration, real Postgres)', () => {
  let tdb: TestDatabase;
  let store: MemoryStore;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    store = new MemoryStore(tdb.db); // no vector store: FTS/entity are SQL-only
  });
  afterAll(async () => {
    await tdb.stop();
  });

  const fact = (content: string, overrides: Partial<NewFact> = {}): NewFact => ({
    content,
    scope: 'private',
    sourceType: 'user_note',
    sourceId: `note-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  });

  it('fts_gated: B private and sensitive rows never reach A through full-text search', async () => {
    // Same content everywhere — only the gates separate the rows.
    const content = 'Maja needs the revised Arkona contract before Thursday';
    const aPrivate = await store.createFromFact(userA, fact(content));
    const bPrivate = await store.createFromFact(userB, fact(content));
    const bShared = await store.createFromFact(userB, fact(content, { scope: 'shared' }));
    const bSensitiveShared = await store.createFromFact(
      userB,
      fact(content, { scope: 'shared', sensitive: true }),
    );
    const aSensitive = await store.createFromFact(userA, fact(content, { sensitive: true }));

    const idsFor = async (principal: Principal, includeSensitive?: boolean) =>
      (await store.ftsSearch(principal, 'Arkona contract', { topK: 20, includeSensitive })).map(
        (hit) => hit.memory.id,
      );

    const aDefault = await idsFor(userA);
    expect(aDefault).toContain(aPrivate.id);
    expect(aDefault).toContain(bShared.id);
    expect(aDefault).not.toContain(bPrivate.id);
    expect(aDefault).not.toContain(bSensitiveShared.id);
    expect(aDefault).not.toContain(aSensitive.id); // sensitive needs opt-in even for the owner

    // Opt-in unlocks only A's OWN sensitive rows — never B's, shared or not.
    const aOptIn = await idsFor(userA, true);
    expect(aOptIn).toContain(aSensitive.id);
    expect(aOptIn).not.toContain(bPrivate.id);
    expect(aOptIn).not.toContain(bSensitiveShared.id);

    // Scores normalized to [0,1], ranked descending.
    const hits = await store.ftsSearch(userA, 'Arkona contract', { topK: 20 });
    for (const hit of hits) {
      expect(hit.score).toBeGreaterThan(0);
      expect(hit.score).toBeLessThanOrEqual(1);
    }
    const scores = hits.map((h) => h.score);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
  });

  it('fts matches across diacritics (simple + unaccent — decision 0006 ruling 1)', async () => {
    const row = await store.createFromFact(
      userA,
      fact('Siniša je potvrdio budžet za Križevce u petak'),
    );
    // Accent-free query text still hits the accented content.
    const hits = await store.ftsSearch(userA, 'budzet Krizevce', { topK: 10 });
    expect(hits.map((h) => h.memory.id)).toContain(row.id);
  });

  it('entity_gated: B private and sensitive rows never reach A through entity search', async () => {
    const entities = ['Vedran', 'Meridian'];
    const aPrivate = await store.createFromFact(
      userA,
      fact('Vedran owes the Meridian figures', { entities }),
    );
    const bPrivate = await store.createFromFact(
      userB,
      fact('Vedran promised the Meridian review', { entities }),
    );
    const bShared = await store.createFromFact(
      userB,
      fact('Vedran booked the Meridian call', { entities, scope: 'shared' }),
    );
    const bSensitiveShared = await store.createFromFact(
      userB,
      fact('Vedran salary discussion at Meridian', { entities, scope: 'shared', sensitive: true }),
    );

    const idsFor = async (principal: Principal, includeSensitive?: boolean) =>
      (await store.entitySearch(principal, ['Vedran'], { topK: 20, includeSensitive })).map(
        (hit) => hit.memory.id,
      );

    const aDefault = await idsFor(userA);
    expect(aDefault).toContain(aPrivate.id);
    expect(aDefault).toContain(bShared.id);
    expect(aDefault).not.toContain(bPrivate.id);
    expect(aDefault).not.toContain(bSensitiveShared.id);

    const aOptIn = await idsFor(userA, true);
    expect(aOptIn).not.toContain(bPrivate.id);
    expect(aOptIn).not.toContain(bSensitiveShared.id);

    // Owner-only sensitive with opt-in — mirrors every other read.
    expect(await idsFor(userB)).not.toContain(bSensitiveShared.id);
    expect(await idsFor(userB, true)).toContain(bSensitiveShared.id);

    // Trigram matching is case-insensitive; scores land in [0,1]; a name with
    // no stored counterpart returns nothing rather than noise.
    const lower = await store.entitySearch(userA, ['vedran'], { topK: 20 });
    expect(lower.map((h) => h.memory.id)).toContain(aPrivate.id);
    for (const hit of lower) {
      expect(hit.score).toBeGreaterThan(0);
      expect(hit.score).toBeLessThanOrEqual(1);
    }
    expect(await store.entitySearch(userA, ['Nonexistent Person'], { topK: 20 })).toEqual([]);
    expect(await store.entitySearch(userA, [], { topK: 20 })).toEqual([]);
  });
});
