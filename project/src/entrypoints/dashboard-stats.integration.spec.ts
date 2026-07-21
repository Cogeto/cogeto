import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MemoryScope, MemoryStatus, Principal, TaskStatus } from '@cogeto/shared';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { MemoryReconciliation, MemoryStore } from '../memory/index';
import type { MemoryRow } from '../memory/index';
import { TasksEngine } from '../tasks/index';
import type { ModelGateway } from '../model-gateway/index';
import type { ApprovalService } from '../agents/index';
import { AttentionService } from './attention.service';

/** Post-v1 Priority 2 (decision 0039): GET /api/dashboard/stats — cheap, gated
 * aggregates. Pure-Postgres; ApprovalService faked (its own gating tested in agents). */

const principalFor = (userId: string, orgId = 'org-a'): Principal => ({
  userId,
  name: 'Tester',
  email: null,
  orgId,
  orgName: orgId,
  roles: [],
});

const throwingGateway = {
  extractStructured: () => {
    throw new Error('stats reads must never call the model');
  },
} as unknown as ModelGateway;

describe('dashboard stats (integration, real Postgres)', () => {
  let tdb: TestDatabase;
  let store: MemoryStore;
  let attention: AttentionService;
  const pendingByOwner = new Map<string, number>();

  beforeAll(async () => {
    tdb = await startTestDatabase();
    store = new MemoryStore(tdb.db);
    const reconciliation = new MemoryReconciliation(tdb.db, store);
    const tasks = new TasksEngine(tdb.db, store, throwingGateway);
    const fakeApprovals = {
      listPending: async (principal: Principal) =>
        Array.from({ length: pendingByOwner.get(principal.userId) ?? 0 }, (_, i) => ({
          id: `a-${i}`,
        })),
    } as unknown as ApprovalService;
    attention = new AttentionService(tdb.db, store, reconciliation, tasks, fakeApprovals);
  });
  afterAll(async () => {
    await tdb.stop();
  });

  const seedMemory = async (
    owner: string,
    opts: {
      status?: MemoryStatus;
      scope?: MemoryScope;
      sourceType?: 'user_note' | 'email' | 'file' | 'chat';
      ageDays?: number;
    } = {},
  ): Promise<MemoryRow> => {
    const row = await store.createFromFact(principalFor(owner), {
      content: 'a fact',
      scope: opts.scope ?? 'private',
      sourceType: opts.sourceType ?? 'user_note',
      sourceId: randomUUID(),
      initialStatus: opts.status === 'uncertain' ? 'uncertain' : undefined,
    });
    // Statuses that createFromFact cannot set are forced directly (test seed).
    if (opts.status && opts.status !== 'active' && opts.status !== 'uncertain') {
      await tdb.pool.query(`UPDATE memory SET status = $2 WHERE id = $1`, [row.id, opts.status]);
    }
    if (opts.ageDays) {
      const then = new Date(Date.now() - opts.ageDays * 86_400_000);
      await tdb.pool.query(`UPDATE memory SET created_at = $2 WHERE id = $1`, [row.id, then]);
    }
    return row;
  };

  const seedTask = async (owner: string, status: TaskStatus): Promise<void> => {
    const mem = await seedMemory(owner);
    await tdb.pool.query(
      `INSERT INTO task (owner_id, scope, derived_from_memory_id, title, status)
       VALUES ($1, 'private', $2, 'a task', $3)`,
      [owner, mem.id, status],
    );
  };

  const seedDreamAction = async (
    owner: string,
    pass: 'dedup' | 'supersession' | 'contradiction',
    runId: string,
  ): Promise<void> => {
    const mem = await seedMemory(owner);
    await tdb.pool.query(`INSERT INTO dream_action (run_id, pass, memory_id) VALUES ($1, $2, $3)`, [
      runId,
      pass,
      mem.id,
    ]);
  };

  const seedContradiction = async (owner: string): Promise<void> => {
    const a = await seedMemory(owner);
    const b = await seedMemory(owner);
    await tdb.pool.query(
      `INSERT INTO memory_relation (kind, a_memory_id, b_memory_id, a_prior_status, b_prior_status)
       VALUES ('contradicts', $1, $2, 'active', 'active')`,
      [a.id, b.id],
    );
  };

  // ── stats_correct ────────────────────────────────────────────────────────────

  it('stats_correct: memory-by-status is exact and gated', async () => {
    const owner = `mem-${randomUUID()}`;
    await seedMemory(owner); // active
    await seedMemory(owner); // active
    await seedMemory(owner, { status: 'uncertain' });
    await seedMemory(owner, { status: 'uncertain' });
    await seedMemory(owner, { status: 'outdated' });
    await seedMemory(owner, { status: 'replaced' });

    const stats = await attention.getStats(principalFor(owner));
    expect(stats.memoryByStatus.active).toBe(2);
    expect(stats.memoryByStatus.uncertain).toBe(2);
    expect(stats.memoryByStatus.outdated).toBe(1);
    expect(stats.memoryByStatus.replaced).toBe(1);
    expect(stats.memoryByStatus.contradicted).toBe(0);
    expect(stats.memoryByStatus.user_approved).toBe(0);
    expect(stats.memoryTotal).toBe(6);
    expect(stats.review.uncertain).toBe(2);
  });

  it('stats_correct: task counts are exact, owner-scoped', async () => {
    const owner = `task-${randomUUID()}`;
    await seedTask(owner, 'open');
    await seedTask(owner, 'open');
    await seedTask(owner, 'blocked_on_condition');
    await seedTask(owner, 'done');
    await seedTask(owner, 'dismissed');

    const stats = await attention.getStats(principalFor(owner));
    expect(stats.tasks).toEqual({ open: 2, blocked: 1, done: 1, dismissed: 1 });
  });

  it('stats_correct: source series is grouped, windowed, and zero-filled', async () => {
    const owner = `src-${randomUUID()}`;
    await seedMemory(owner, { sourceType: 'user_note' });
    await seedMemory(owner, { sourceType: 'user_note' });
    await seedMemory(owner, { sourceType: 'email' });
    await seedMemory(owner, { sourceType: 'file', ageDays: 1 });
    // Outside the 30-day window — must be excluded from the series.
    await seedMemory(owner, { sourceType: 'user_note', ageDays: 40 });

    const stats = await attention.getStats(principalFor(owner));
    expect(stats.sources.days).toBe(30);
    expect(stats.sources.series).toHaveLength(30);
    expect(stats.sources.keys).toEqual(['notes', 'email', 'files']);

    const total = (key: string) =>
      stats.sources.series.reduce((sum, day) => sum + (day.counts[key] ?? 0), 0);
    expect(total('notes')).toBe(2); // the 40-day-old note is windowed out
    expect(total('email')).toBe(1);
    expect(total('files')).toBe(1);

    // Honest axis: no day older than the window; every day zero-filled.
    const oldest = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    for (const day of stats.sources.series) {
      expect(day.date >= oldest).toBe(true);
      for (const key of stats.sources.keys) expect(typeof day.counts[key]).toBe('number');
    }
  });

  it('stats_correct: dreaming activity folds merges vs conflicts, gated', async () => {
    const owner = `dream-${randomUUID()}`;
    const { rows } = await tdb.pool.query<{ id: string }>(
      `INSERT INTO dream_run (scope_from, scope_to, started_at, finished_at)
       VALUES (now() - interval '1 hour', now(), now(), now()) RETURNING id`,
    );
    const runId = rows[0]!.id;
    await seedDreamAction(owner, 'dedup', runId);
    await seedDreamAction(owner, 'supersession', runId);
    await seedDreamAction(owner, 'contradiction', runId);

    const stats = await attention.getStats(principalFor(owner));
    expect(stats.dreaming.keys).toEqual(['merges', 'conflicts']);
    const total = (key: string) =>
      stats.dreaming.series.reduce((sum, day) => sum + (day.counts[key] ?? 0), 0);
    expect(total('merges')).toBe(2); // dedup + supersession
    expect(total('conflicts')).toBe(1);

    // A stranger sees none of it (gated resolution).
    const strangerStats = await attention.getStats(
      principalFor(`stranger-${randomUUID()}`, 'org-b'),
    );
    const strangerMerges = strangerStats.dreaming.series.reduce(
      (sum, day) => sum + (day.counts.merges ?? 0),
      0,
    );
    expect(strangerMerges).toBe(0);
  });

  it('stats_correct: review + approvals reflect the owner queues', async () => {
    const owner = `rev-${randomUUID()}`;
    await seedMemory(owner, { status: 'uncertain', ageDays: 5 });
    await seedMemory(owner, { status: 'uncertain' });
    await seedContradiction(owner);
    pendingByOwner.set(owner, 2);

    const stats = await attention.getStats(principalFor(owner));
    expect(stats.review.uncertain).toBe(2);
    expect(stats.review.contradicted).toBe(1);
    expect(stats.review.oldestAt).not.toBeNull();
    expect(stats.approvalsPending).toBe(2);
    pendingByOwner.delete(owner);
  });

  // ── stats_cheap ──────────────────────────────────────────────────────────────

  it('stats_cheap: the query count is bounded and constant regardless of data volume', async () => {
    const owner = `cheap-${randomUUID()}`;

    // A fixed query SHAPE: some of every signal, so no conditional branch is
    // skipped (e.g. the dreaming activity's visibility resolution always runs).
    const seedShape = async (multiplier: number): Promise<void> => {
      const { rows } = await tdb.pool.query<{ id: string }>(
        `INSERT INTO dream_run (scope_from, scope_to, started_at, finished_at)
         VALUES (now() - interval '1 hour', now(), now(), now()) RETURNING id`,
      );
      const runId = rows[0]!.id;
      for (let i = 0; i < multiplier; i += 1) {
        await seedMemory(owner, { status: 'uncertain' });
        await seedTask(owner, 'open');
        await seedDreamAction(owner, 'dedup', runId);
      }
    };

    const countQueries = async (): Promise<number> => {
      const original = tdb.pool.query.bind(tdb.pool);
      let n = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tdb.pool as any).query = (...args: unknown[]) => {
        n += 1;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (original as any)(...args);
      };
      try {
        await attention.getStats(principalFor(owner));
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tdb.pool as any).query = original;
      }
      return n;
    };

    await seedShape(1);
    const small = await countQueries();
    await seedShape(10); // 10× the data, same shape
    const large = await countQueries();

    // The instrumentation actually captured the reads...
    expect(small).toBeGreaterThan(0);
    // ...the endpoint issues a small, FIXED set of queries — no per-row fan-out,
    // no scan that grows with the store.
    expect(large).toBe(small);
    expect(small).toBeLessThan(25);
  });
});
