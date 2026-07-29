import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { createMemoryStore } from '../memory/index';
import type { MemoryRow, MemoryStore, NewFact } from '../memory/index';
import { UserDirectory } from '../identity/index';

/**
 * The cross-user scope proof. Two Principals in ONE org (A, B) plus a
 * third in ANOTHER org (C) — exercising every read path the gates guard and
 * every write path they own. Cross-org isolation for SHARED rows is a
 * deployment boundary, not a row gate: this suite proves the
 * same-org contract exhaustively and the cross-org PRIVATE isolation the owner
 * gate does enforce; shared cross-org is called out in the session log as
 * deployment-enforced, not row-tested.
 *
 * The chat retrieval context is exactly these gated primitives (vector / fts /
 * entity / point-in-time / changes-since) — the retrieval service adds no
 * ungated path (verified), so proving the primitives proves chat retrieval.
 */

const DIMS = 8;
const EMBED = 'test-embed';
const VEC = [1, 0, 0, 0, 0, 0, 0, 0];

const principal = (userId: string, orgId: string): Principal => ({
  userId,
  name: `name-of-${userId}`,
  email: null,
  orgId,
  orgName: orgId,
  roles: [],
});

describe('cross-user scope isolation (integration, real Postgres + Qdrant)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;
  let directory: UserDirectory;

  // org alpha: A and B; org beta: C.
  const orgAlpha = `alpha-${randomUUID()}`;
  const orgBeta = `beta-${randomUUID()}`;
  const A = principal(`userA-${randomUUID()}`, orgAlpha);
  const B = principal(`userB-${randomUUID()}`, orgAlpha);
  const C = principal(`userC-${randomUUID()}`, orgBeta);

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    store = createMemoryStore({
      db: tdb.db,
      qdrant: { url: qdrant.url, embeddingModel: EMBED, dimensions: DIMS },
    });
    await store.ensureIndexReady();
    directory = new UserDirectory(tdb.db);
    await Promise.all([directory.record(A), directory.record(B), directory.record(C)]);
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  const seed = async (
    owner: Principal,
    fact: Partial<NewFact> & { content: string },
    vector: number[] | null = VEC,
  ): Promise<MemoryRow> => {
    const row = await store.createFromFact(owner, {
      scope: 'private',
      sourceType: 'user_note',
      sourceId: randomUUID(),
      entities: [],
      embeddingModel: EMBED,
      ...fact,
    } as NewFact);
    if (vector) await store.upsertVectors([row], [vector]);
    return row;
  };

  const visIds = async (p: Principal, opts = {}): Promise<Set<string>> =>
    new Set((await store.listForPrincipal(p, opts)).map((r) => r.id));
  const vecIds = async (p: Principal): Promise<Set<string>> =>
    new Set(
      (await store.vectorSearch(p, VEC, { topK: 50, includeSensitive: true })).map(
        (h) => h.memoryId,
      ),
    );

  it('private_invisible_to_org_peer: every read path hides A’s private fact from B', async () => {
    const priv = await seed(A, {
      content: 'A private salary figure for Zebra',
      entities: ['Zebra'],
      subjectEntity: 'Zebra',
    });

    // Direct get, list, fts, entity, vector, point-in-time, changes-since.
    expect(await store.getForPrincipal(B, priv.id)).toBeNull();
    expect(await visIds(B)).not.toContain(priv.id);
    expect(
      (await store.ftsSearch(B, 'salary Zebra', { topK: 50 })).map((h) => h.memory.id),
    ).not.toContain(priv.id);
    expect(
      (await store.entitySearch(B, ['Zebra'], { topK: 50 })).map((h) => h.memory.id),
    ).not.toContain(priv.id);
    expect(await vecIds(B)).not.toContain(priv.id);
    const pit = await store.pointInTime(B, new Date(), { topK: 50, embedding: VEC });
    expect(pit.map((h) => h.memory.id)).not.toContain(priv.id);
    const since = new Date(Date.now() - 3600_000);
    expect((await store.changesSince(B, since)).map((c) => c.memory.id)).not.toContain(priv.id);

    // ...but A sees their own everywhere.
    expect(await store.getForPrincipal(A, priv.id)).not.toBeNull();
    expect(await vecIds(A)).toContain(priv.id);
  });

  it('shared_visible_to_org_peer: a shared fact reaches B on every read path, attributed to A', async () => {
    const shared = await seed(A, {
      content: 'The Yak account renews in March',
      scope: 'shared',
      entities: ['Yak'],
      subjectEntity: 'Yak',
    });

    expect(await store.getForPrincipal(B, shared.id)).not.toBeNull();
    expect(await visIds(B)).toContain(shared.id);
    expect(
      (await store.ftsSearch(B, 'Yak renews', { topK: 50 })).map((h) => h.memory.id),
    ).toContain(shared.id);
    expect((await store.entitySearch(B, ['Yak'], { topK: 50 })).map((h) => h.memory.id)).toContain(
      shared.id,
    );
    expect(await vecIds(B)).toContain(shared.id);

    // Attribution: the owner resolves to A's directory name.
    const names = await directory.displayNames([shared.ownerId]);
    expect(names.get(A.userId)).toBe(A.name);
  });

  it('sensitive_shared_stays_owner_only: shared + sensitive never reaches a peer', async () => {
    const secret = await seed(A, {
      content: 'Shared but sensitive: the Whale acquisition price',
      scope: 'shared',
      sensitive: true,
      entities: ['Whale'],
    });
    // Even with the shared arm, the sensitive gate keeps it to A.
    expect(await store.getForPrincipal(B, secret.id, { includeSensitive: true })).toBeNull();
    expect(await visIds(B, { includeSensitive: true })).not.toContain(secret.id);
    expect(await vecIds(B)).not.toContain(secret.id);
    // A sees it with the opt-in.
    expect(await store.getForPrincipal(A, secret.id, { includeSensitive: true })).not.toBeNull();
  });

  it('mutation_blocked_for_peer: every owner-only write on A’s shared fact 404s for B', async () => {
    const shared = await seed(A, { content: 'A shared decision about Owl', scope: 'shared' });
    await expect(store.setScope(B, shared.id, 'private')).rejects.toThrow(/not found/i);
    await expect(store.toggleSensitive(B, shared.id, true)).rejects.toThrow(/not found/i);
    await expect(
      store.transition({ kind: 'user', userId: B.userId }, shared.id, 'outdated', 'peer'),
    ).rejects.toThrow(/not found/i);
    await expect(store.editContent(B, shared.id, 'peer tries to edit')).rejects.toThrow(
      /not found/i,
    );
    // A can still act on their own.
    const outdated = await store.transition(
      { kind: 'user', userId: A.userId },
      shared.id,
      'outdated',
      'owner',
    );
    expect(outdated.status).toBe('outdated');
  });

  it('scope_change_propagates_to_reads_and_qdrant: private→shared→private flips B’s visibility', async () => {
    const m = await seed(A, {
      content: 'A fact about Raven that will change scope',
      entities: ['Raven'],
    });
    // Private: invisible to B in list AND vector (Qdrant payload).
    expect(await visIds(B)).not.toContain(m.id);
    expect(await vecIds(B)).not.toContain(m.id);

    await store.setScope(A, m.id, 'shared');
    expect(await visIds(B)).toContain(m.id);
    expect(await vecIds(B)).toContain(m.id); // payload updated in the same op

    await store.setScope(A, m.id, 'private');
    expect(await visIds(B)).not.toContain(m.id);
    expect(await vecIds(B)).not.toContain(m.id); // demote reaches Qdrant immediately
  });

  it('cross_org_private_isolated: C (another org) never sees A’s private fact', async () => {
    const priv = await seed(A, {
      content: 'A org-alpha-only private fact about Ibis',
      entities: ['Ibis'],
    });
    expect(await store.getForPrincipal(C, priv.id)).toBeNull();
    expect(await visIds(C)).not.toContain(priv.id);
    expect(await vecIds(C)).not.toContain(priv.id);
    // NOTE: a SHARED fact is NOT row-isolated across orgs — that boundary is the
    // single-tenant deployment, so it is deliberately not
    // asserted here. In production C authenticates against a different instance.
  });

  it('open_loops_shared_visible: A’s shared commitment reaches B’s open loops', async () => {
    const sharedCommit = await store.createFromFact(A, {
      content: 'You will circulate the Puffin summary.',
      scope: 'shared',
      sourceType: 'user_note',
      sourceId: randomUUID(),
      entities: ['Puffin'],
      kind: 'commitment',
      embeddingModel: EMBED,
    } as NewFact);

    const bLoops = await store.openLoopsForPrincipal(B);
    expect(bLoops.map((m) => m.id)).toContain(sharedCommit.id);
  });

  it('open_loops_private_not_visible_to_peer: A’s private commitment never reaches B', async () => {
    const priv = await store.createFromFact(A, {
      content: 'You will file the private Gecko report.',
      scope: 'private',
      sourceType: 'user_note',
      sourceId: randomUUID(),
      entities: ['Gecko'],
      kind: 'commitment',
      embeddingModel: EMBED,
    } as NewFact);
    const bLoops = await store.openLoopsForPrincipal(B);
    expect(bLoops.map((m) => m.id)).not.toContain(priv.id);
    expect(bLoops.some((m) => (m.content ?? '').includes('Gecko'))).toBe(false);
    // …and A still sees their own.
    expect((await store.openLoopsForPrincipal(A)).map((m) => m.id)).toContain(priv.id);
  });

  it('open_loops_sensitive_gated: a sensitive commitment needs the owner’s opt-in', async () => {
    const sensitive = await store.createFromFact(A, {
      content: 'You will renegotiate the confidential Osprey retainer.',
      scope: 'shared',
      sourceType: 'user_note',
      sourceId: randomUUID(),
      entities: ['Osprey'],
      kind: 'commitment',
      sensitive: true,
      embeddingModel: EMBED,
    } as NewFact);
    // Excluded by default, even for the owner.
    expect((await store.openLoopsForPrincipal(A)).map((m) => m.id)).not.toContain(sensitive.id);
    // Returned to the owner on explicit opt-in …
    expect(
      (await store.openLoopsForPrincipal(A, { includeSensitive: true })).map((m) => m.id),
    ).toContain(sensitive.id);
    // … and never to a peer, opt-in or not.
    expect(
      (await store.openLoopsForPrincipal(B, { includeSensitive: true })).map((m) => m.id),
    ).not.toContain(sensitive.id);
  });

  it('open_loops_settled_excluded: outdated/replaced commitments stop standing', async () => {
    const src = randomUUID();
    const commitment = await store.createFromFact(A, {
      content: 'You will send the Kestrel invoice.',
      scope: 'private',
      sourceType: 'user_note',
      sourceId: src,
      entities: ['Kestrel'],
      kind: 'commitment',
      embeddingModel: EMBED,
    } as NewFact);
    expect((await store.openLoopsForPrincipal(A)).map((m) => m.id)).toContain(commitment.id);

    await store.transition(
      { kind: 'user', userId: A.userId },
      commitment.id,
      'outdated',
      'settled in the integration test',
    );
    expect((await store.openLoopsForPrincipal(A)).map((m) => m.id)).not.toContain(commitment.id);
  });

  it('review_own_only: a peer’s shared uncertain fact is readable but NOT in B’s Review queue', async () => {
    const sharedUncertain = await store.createFromFact(A, {
      content: 'A shared but unverified claim about Heron',
      scope: 'shared',
      sourceType: 'user_note',
      sourceId: randomUUID(),
      entities: ['Heron'],
      initialStatus: 'uncertain',
      embeddingModel: EMBED,
    } as NewFact);
    // Visible to B as a shared memory…
    expect(await visIds(B, { status: 'uncertain', includeSensitive: true })).toContain(
      sharedUncertain.id,
    );
    // …but NOT in B's Review queue (mine): you review only your own.
    expect(
      await visIds(B, { status: 'uncertain', mine: true, includeSensitive: true }),
    ).not.toContain(sharedUncertain.id);
    // A's own review queue does contain it.
    expect(await visIds(A, { status: 'uncertain', mine: true, includeSensitive: true })).toContain(
      sharedUncertain.id,
    );
  });

  it('audit_detail_carries_no_memory_content: creation audit records ids, not the fact text', async () => {
    const content = `secret marker ${randomUUID()}`;
    const m = await seed(A, { content });
    const { rows } = await tdb.pool.query<{ detail_json: unknown }>(
      `SELECT detail_json FROM audit_log WHERE entity_id = $1 AND action = 'memory.created'`,
      [m.id],
    );
    expect(rows.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(rows.map((r) => r.detail_json));
    expect(serialized).not.toContain(content); // no memory content leaks into audit
  });
});
