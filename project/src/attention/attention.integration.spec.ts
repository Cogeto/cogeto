import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalDto, MemoryScope, MemoryStatus, Principal } from '@cogeto/shared';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { UserContextService } from '../infrastructure/index';
import { MemoryReconciliation, MemoryStore } from '../memory/index';
import type { MemoryRow } from '../memory/index';
import { RetrievalService } from '../retrieval/index';
import type { ModelGateway } from '../model-gateway/index';
import type { ApprovalService } from '../agents/index';
import { AttentionService } from './attention.service';

/**
 * The attention feed: a COMPUTED, gated
 * layer over open loops / review / approvals / the dreaming digest.
 * Pure-Postgres —
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
  let retrieval: RetrievalService;
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
    retrieval = new RetrievalService(store, throwingGateway, { db: tdb.db });
    attention = new AttentionService(
      tdb.db,
      store,
      reconciliation,
      retrieval,
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
      // The taxonomy is total: an uncertain admission always names its reason.
      uncertaintyReason: opts.status === 'uncertain' ? 'unsupported' : undefined,
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

  /**
   * An open loop, exactly as the instance produces one since: a
   * commitment memory, its due date on `valid_until`, its "gone quiet" state
   * in ingestion's dormant_flag. No derived table involved.
   */
  const seedOpenLoop = async (
    owner: string,
    opts: { title?: string; scope?: MemoryScope; due?: Date | null; dormant?: boolean } = {},
  ): Promise<string> => {
    const mem = await seedMemory(owner, {
      content: opts.title ?? 'a commitment',
      scope: opts.scope,
    });
    // authored_by_user: an open loop is the user's own promise, so the fixture
    // models a note they wrote. A document's obligation is excluded by the
    // first-person rule and would never reach this feed.
    await tdb.pool.query(
      `UPDATE memory SET kind = 'commitment', valid_until = $2, authored_by_user = true WHERE id = $1`,
      [mem.id, opts.due ?? null],
    );
    if (opts.dormant) {
      await tdb.pool.query(`INSERT INTO dormant_flag (memory_id, reason) VALUES ($1, 'quiet')`, [
        mem.id,
      ]);
    }
    return mem.id;
  };

  /** `ageMinutes` backdates the detection; `detectedInSeconds` pushes it ahead
   * of the wall clock, which the unread comparison needs to be strict about. */
  const seedContradiction = async (
    owner: string,
    opts: { ageMinutes?: number; detectedInSeconds?: number } = {},
  ): Promise<void> => {
    const a = await seedMemory(owner, { content: 'Workshop platform is Teams.' });
    const b = await seedMemory(owner, { content: 'Workshop platform is Zoom.' });
    const { rows } = await tdb.pool.query<{ id: string }>(
      `INSERT INTO memory_relation (kind, a_memory_id, b_memory_id, a_prior_status, b_prior_status)
       VALUES ('contradicts', $1, $2, 'active', 'active') RETURNING id`,
      [a.id, b.id],
    );
    if (opts.ageMinutes) {
      await tdb.pool.query(`UPDATE memory_relation SET detected_at = $2 WHERE id = $1`, [
        rows[0]!.id,
        new Date(Date.now() - opts.ageMinutes * 60_000),
      ]);
    }
    if (opts.detectedInSeconds) {
      await tdb.pool.query(
        `UPDATE memory_relation SET detected_at = now() + ($2 || ' seconds')::interval WHERE id = $1`,
        [rows[0]!.id, String(opts.detectedInSeconds)],
      );
    }
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
    const overdueId = await seedOpenLoop(owner, {
      title: 'Send Marko the proposal',
      due: overdue,
    });
    await seedOpenLoop(owner, { title: 'Follow up with the notary', dormant: true });
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
    expect(kinds).toContain('open_loop_overdue');
    expect(kinds).toContain('open_loop_quiet');
    expect(kinds).toContain('review_contradicted');
    // no_uncertain_queue: uncertain facts are resolved automatically
    // (V2.0 item 3.3), so the feed never asks the reader to review one.
    expect(kinds).not.toContain('review_uncertain');
    expect(kinds).toContain('approval_pending');
    expect(kinds).toContain('digest_change');

    // Every item is typed, human-titled, timestamped, and deep-linked.
    for (const item of feed.items) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(() => new Date(item.timestamp).toISOString()).not.toThrow();
      expect(item.href.startsWith('/')).toBe(true);
    }
    // Deep links resolve: the overdue link opens the FACT itself in the memory
    // drawer (where its due date and provenance live); the digest merge link
    // opens a memory that exists for the caller.
    expect(feed.items.find((i) => i.kind === 'open_loop_overdue')!.href).toBe(
      `/memories?open=${overdueId}`,
    );
    const digest = feed.items.find((i) => i.kind === 'digest_change')!;
    expect(digest.href).toBe(`/memories?open=${memId}`);
    expect(digest.key).toBe(`digest:${runId}:0`);
    expect(digest.dismissible).toBe(true);
    // A live count is never dismissible.
    expect(feed.items.find((i) => i.kind === 'review_contradicted')!.dismissible).toBe(false);
    // The most-pressing item (overdue) sorts first.
    expect(feed.items[0]!.kind).toBe('open_loop_overdue');
    pendingByOwner.delete(owner);
  });

  // ── attention_gated ──────────────────────────────────────────────────────────

  it("attention_gated: a different user sees none of another user's private items or counts", async () => {
    const alice = `alice-${randomUUID()}`;
    const bob = `bob-${randomUUID()}`;

    await seedOpenLoop(alice, {
      title: 'Alice private commitment',
      due: new Date(Date.now() - 86_400_000),
    });
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
    expect(statsBob.openLoops).toBe(0);
    expect(statsBob.review.contradicted).toBe(0);
  });

  it('attention_gated: a shared uncertain fact raises no review item for anyone', async () => {
    const owner = `share-${randomUUID()}`;
    const peer = `peer-${randomUUID()}`;
    // A shared uncertain fact of the owner's.
    await seedMemory(owner, { content: 'shared unsure', status: 'uncertain', scope: 'shared' });

    // Not for the owner: Cogeto resolved it, so there is nothing to adjudicate.
    const ownerFeed = await attention.getFeed(principalFor(owner));
    expect(ownerFeed.items.some((i) => i.kind === 'review_contradicted')).toBe(false);
    // Nor for a peer, who could not action it even when queues existed.
    const peerFeed = await attention.getFeed(principalFor(peer));
    expect(peerFeed.items).toHaveLength(0);
  });

  // ── unread_semantics ─────────────────────────────────────────────────────────

  it('unread_semantics: new items set the indicator; viewing clears it; new items re-raise', async () => {
    const owner = `unread-${randomUUID()}`;
    const p = principalFor(owner);

    // An older contradiction (10 min ago) — clearly before we mark seen.
    await seedContradiction(owner, { ageMinutes: 10 });

    const first = await attention.getFeed(p);
    expect(first.lastSeenAt).toBeNull();
    expect(first.unreadCount).toBeGreaterThanOrEqual(1);
    expect(first.items.every((i) => i.unread)).toBe(true);

    // Viewing the surface clears the indicator (not clicking each item).
    await attention.markSeen(p);
    const afterSeen = await attention.getFeed(p);
    expect(afterSeen.lastSeenAt).not.toBeNull();
    expect(afterSeen.unreadCount).toBe(0);
    expect(afterSeen.items.find((i) => i.kind === 'review_contradicted')!.unread).toBe(false);

    // A brand-new contradiction re-raises the indicator. Its detection time is
    // stamped a second past the seen mark rather than left to the wall clock
    // "unread" is a strict timestamp comparison, and a row written inside the
    // same millisecond as markSeen is genuinely not newer than it.
    await seedContradiction(owner, { detectedInSeconds: 1 });
    const afterNew = await attention.getFeed(p);
    expect(afterNew.unreadCount).toBeGreaterThanOrEqual(1);
    expect(afterNew.items.find((i) => i.kind === 'review_contradicted')!.unread).toBe(true);
  });

  it('unread_semantics: digest dismissal persists and is per-item; a live count cannot be dismissed', async () => {
    const owner = `dismiss-${randomUUID()}`;
    const p = principalFor(owner);
    const { runId } = await seedDigestRun(owner);
    await seedContradiction(owner);

    const key = `digest:${runId}:0`;
    const before = await attention.getFeed(p);
    expect(before.items.some((i) => i.key === key)).toBe(true);

    await attention.dismiss(p, key);
    const after = await attention.getFeed(p);
    expect(after.items.some((i) => i.key === key)).toBe(false);
    // The review count survives — dismissal is per-item and digest-only.
    expect(after.items.some((i) => i.kind === 'review_contradicted')).toBe(true);

    // Re-fetch: the dismissal persisted.
    const again = await attention.getFeed(p);
    expect(again.items.some((i) => i.key === key)).toBe(false);

    // A live count is not dismissible.
    await expect(attention.dismiss(p, 'review:uncertain')).rejects.toThrow();
  });
});
