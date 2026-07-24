import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalDto, MemoryScope, MemoryStatus, Principal } from '@cogeto/shared';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { UserContextService } from '../infrastructure/index';
import { MemoryReconciliation, MemoryStore } from '../memory/index';
import type { MemoryRow } from '../memory/index';
import { TasksEngine } from '../tasks/index';
import type { ModelGateway } from '../model-gateway/index';
import type { ApprovalService } from '../agents/index';
import { AttentionService } from './attention.service';

/**
 * The attention feed (Post-v1 Priority 2, decision 0039): a COMPUTED, gated
 * layer over tasks / review / approvals / the dreaming digest. Pure-Postgres —
 * none of the read paths touch Qdrant, so the test needs no vector store.
 *
 * ApprovalService is faked (its own gating is tested in agents/*) so this suite
 * asserts AttentionService's composition, gating, unread semantics and
 * dismissal without standing up the whole approval machine.
 */

const principalFor = (userId: string, orgId = 'org-a'): Principal => ({
  userId,
  name: 'Tester',
  email: null,
  orgId,
  orgName: orgId,
  roles: [],
});

/** Gateway is never called on the attention read paths — a throwing stub proves it. */
const throwingGateway = {
  extractStructured: () => {
    throw new Error('attention reads must never call the model');
  },
} as unknown as ModelGateway;

describe('attention feed (integration, real Postgres)', () => {
  let tdb: TestDatabase;
  let store: MemoryStore;
  let reconciliation: MemoryReconciliation;
  let tasks: TasksEngine;
  const pendingByOwner = new Map<string, ApprovalDto[]>();

  const fakeApprovals = {
    listPending: async (principal: Principal): Promise<ApprovalDto[]> =>
      pendingByOwner.get(principal.userId) ?? [],
  } as unknown as ApprovalService;

  let attention: AttentionService;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    store = new MemoryStore(tdb.db);
    reconciliation = new MemoryReconciliation(tdb.db, store);
    tasks = new TasksEngine(tdb.db, store, throwingGateway);
    attention = new AttentionService(
      tdb.db,
      store,
      reconciliation,
      tasks,
      fakeApprovals,
      new UserContextService(tdb.db),
    );
  });
  afterAll(async () => {
    await tdb.stop();
  });

  // ── Seed helpers (direct inserts — the signals the instance produces) ────────

  const seedMemory = async (
    owner: string,
    opts: {
      content?: string;
      scope?: MemoryScope;
      status?: MemoryStatus;
      subjectEntity?: string;
      sourceType?: 'user_note' | 'email' | 'file' | 'chat';
      ageMinutes?: number;
    } = {},
  ): Promise<MemoryRow> => {
    const row = await store.createFromFact(principalFor(owner), {
      content: opts.content ?? 'a note',
      scope: opts.scope ?? 'private',
      sourceType: opts.sourceType ?? 'user_note',
      sourceId: randomUUID(),
      subjectEntity: opts.subjectEntity,
      initialStatus: opts.status === 'uncertain' ? 'uncertain' : undefined,
    });
    if (opts.ageMinutes) {
      const then = new Date(Date.now() - opts.ageMinutes * 60_000);
      await tdb.pool.query(`UPDATE memory SET created_at = $2, updated_at = $2 WHERE id = $1`, [
        row.id,
        then,
      ]);
    }
    return row;
  };

  const seedTask = async (
    owner: string,
    opts: { title?: string; scope?: MemoryScope; due?: Date | null; dormant?: boolean } = {},
  ): Promise<string> => {
    const mem = await seedMemory(owner, {
      content: opts.title ?? 'a commitment',
      scope: opts.scope,
    });
    const { rows } = await tdb.pool.query<{ id: string }>(
      `INSERT INTO task (owner_id, scope, derived_from_memory_id, title, status, due, dormant, updated_at)
       VALUES ($1, $2, $3, $4, 'open', $5, $6, now()) RETURNING id`,
      [
        owner,
        opts.scope ?? 'private',
        mem.id,
        opts.title ?? 'A commitment',
        opts.due ?? null,
        opts.dormant ?? false,
      ],
    );
    return rows[0]!.id;
  };

  const seedContradiction = async (owner: string): Promise<void> => {
    const a = await seedMemory(owner, { content: 'Workshop platform is Teams.' });
    const b = await seedMemory(owner, { content: 'Workshop platform is Zoom.' });
    await tdb.pool.query(
      `INSERT INTO memory_relation (kind, a_memory_id, b_memory_id, a_prior_status, b_prior_status)
       VALUES ('contradicts', $1, $2, 'active', 'active')`,
      [a.id, b.id],
    );
  };

  const seedDigestRun = async (owner: string): Promise<{ runId: string; memId: string }> => {
    const mem = await seedMemory(owner, { subjectEntity: 'Atlas Migration' });
    const { rows } = await tdb.pool.query<{ id: string }>(
      `INSERT INTO dream_run (scope_from, scope_to, started_at, finished_at)
       VALUES (now() - interval '1 hour', now(), now(), now()) RETURNING id`,
    );
    const runId = rows[0]!.id;
    await tdb.pool.query(
      `INSERT INTO dream_action (run_id, pass, memory_id) VALUES ($1, 'dedup', $2)`,
      [runId, mem.id],
    );
    return { runId, memId: mem.id };
  };

  // ── attention_feed_composition ───────────────────────────────────────────────

  it('attention_feed_composition: seeded signals produce exactly the expected typed items', async () => {
    const owner = `compose-${randomUUID()}`;
    const p = principalFor(owner);

    const overdue = new Date(Date.now() - 3 * 86_400_000);
    await seedTask(owner, { title: 'Send Marko the proposal', due: overdue });
    await seedTask(owner, { title: 'Follow up with the notary', dormant: true });
    await seedMemory(owner, { content: 'unsure fact', status: 'uncertain' });
    await seedContradiction(owner);
    const { runId, memId } = await seedDigestRun(owner);
    pendingByOwner.set(owner, [
      {
        id: 'appr-1',
        actionType: 'x',
        status: 'pending_approval',
        summary: 'Send the reply to Ana',
        preview: [],
        requestedBy: owner,
        createdAt: new Date().toISOString(),
        expiresAt: null,
        decidedBy: null,
        decidedAt: null,
        executedAt: null,
        result: null,
      },
    ]);

    const feed = await attention.getFeed(p);
    const kinds = feed.items.map((i) => i.kind);
    expect(kinds).toContain('task_overdue');
    expect(kinds).toContain('task_dormant');
    expect(kinds).toContain('review_uncertain');
    expect(kinds).toContain('review_contradicted');
    expect(kinds).toContain('approval_pending');
    expect(kinds).toContain('digest_change');

    // Every item is typed, human-titled, timestamped, and deep-linked.
    for (const item of feed.items) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(() => new Date(item.timestamp).toISOString()).not.toThrow();
      expect(item.href.startsWith('/')).toBe(true);
    }
    // Deep links resolve: the overdue link goes to /tasks; the digest merge link
    // opens a memory that exists for the caller.
    expect(feed.items.find((i) => i.kind === 'task_overdue')!.href).toBe('/tasks');
    const digest = feed.items.find((i) => i.kind === 'digest_change')!;
    expect(digest.href).toBe(`/memories?open=${memId}`);
    expect(digest.key).toBe(`digest:${runId}:0`);
    expect(digest.dismissible).toBe(true);
    // A live count is never dismissible.
    expect(feed.items.find((i) => i.kind === 'review_uncertain')!.dismissible).toBe(false);
    // The most-pressing item (overdue) sorts first.
    expect(feed.items[0]!.kind).toBe('task_overdue');
    pendingByOwner.delete(owner);
  });

  // ── attention_gated ──────────────────────────────────────────────────────────

  it("attention_gated: a different user sees none of another user's private items or counts", async () => {
    const alice = `alice-${randomUUID()}`;
    const bob = `bob-${randomUUID()}`;

    await seedTask(alice, { title: 'Alice private task', due: new Date(Date.now() - 86_400_000) });
    await seedMemory(alice, { content: 'alice secret', status: 'uncertain' });
    await seedContradiction(alice);
    await seedDigestRun(alice);

    const feedAlice = await attention.getFeed(principalFor(alice));
    expect(feedAlice.items.length).toBeGreaterThan(0);

    // Bob — a different user — sees nothing of Alice's private signals.
    const feedBob = await attention.getFeed(principalFor(bob, 'org-b'));
    expect(feedBob.items).toEqual([]);
    expect(feedBob.unreadCount).toBe(0);

    const statsBob = await attention.getStats(principalFor(bob, 'org-b'));
    expect(statsBob.memoryTotal).toBe(0);
    expect(statsBob.tasks.open).toBe(0);
    expect(statsBob.review.uncertain).toBe(0);
    expect(statsBob.review.contradicted).toBe(0);
  });

  it("attention_gated: a shared uncertain fact never enters a peer's owner-only review count", async () => {
    const owner = `share-${randomUUID()}`;
    const peer = `peer-${randomUUID()}`;
    // A shared uncertain fact of the owner's.
    await seedMemory(owner, { content: 'shared unsure', status: 'uncertain', scope: 'shared' });

    // The owner reviews their own uncertain fact...
    const ownerFeed = await attention.getFeed(principalFor(owner));
    expect(ownerFeed.items.some((i) => i.kind === 'review_uncertain')).toBe(true);
    // ...but a peer does NOT — Review is owner-only, even for shared facts.
    const peerFeed = await attention.getFeed(principalFor(peer));
    expect(peerFeed.items.some((i) => i.kind === 'review_uncertain')).toBe(false);
    const peerStats = await attention.getStats(principalFor(peer));
    expect(peerStats.review.uncertain).toBe(0);
  });

  // ── unread_semantics ─────────────────────────────────────────────────────────

  it('unread_semantics: new items set the indicator; viewing clears it; new items re-raise', async () => {
    const owner = `unread-${randomUUID()}`;
    const p = principalFor(owner);

    // An older uncertain fact (10 min ago) — clearly before we mark seen.
    await seedMemory(owner, { content: 'old unsure', status: 'uncertain', ageMinutes: 10 });

    const first = await attention.getFeed(p);
    expect(first.lastSeenAt).toBeNull();
    expect(first.unreadCount).toBeGreaterThanOrEqual(1);
    expect(first.items.every((i) => i.unread)).toBe(true);

    // Viewing the surface clears the indicator (not clicking each item).
    await attention.markSeen(p);
    const afterSeen = await attention.getFeed(p);
    expect(afterSeen.lastSeenAt).not.toBeNull();
    expect(afterSeen.unreadCount).toBe(0);
    expect(afterSeen.items.find((i) => i.kind === 'review_uncertain')!.unread).toBe(false);

    // A brand-new uncertain fact re-raises the indicator.
    await seedMemory(owner, { content: 'new unsure', status: 'uncertain' });
    const afterNew = await attention.getFeed(p);
    expect(afterNew.unreadCount).toBeGreaterThanOrEqual(1);
    expect(afterNew.items.find((i) => i.kind === 'review_uncertain')!.unread).toBe(true);
  });

  it('unread_semantics: digest dismissal persists and is per-item; a live count cannot be dismissed', async () => {
    const owner = `dismiss-${randomUUID()}`;
    const p = principalFor(owner);
    const { runId } = await seedDigestRun(owner);
    await seedMemory(owner, { content: 'unsure', status: 'uncertain' });

    const key = `digest:${runId}:0`;
    const before = await attention.getFeed(p);
    expect(before.items.some((i) => i.key === key)).toBe(true);

    await attention.dismiss(p, key);
    const after = await attention.getFeed(p);
    expect(after.items.some((i) => i.key === key)).toBe(false);
    // The review count survives — dismissal is per-item and digest-only.
    expect(after.items.some((i) => i.kind === 'review_uncertain')).toBe(true);

    // Re-fetch: the dismissal persisted.
    const again = await attention.getFeed(p);
    expect(again.items.some((i) => i.key === key)).toBe(false);

    // A live count is not dismissible.
    await expect(attention.dismiss(p, 'review:uncertain')).rejects.toThrow();
  });
});
