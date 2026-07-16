import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOnce } from 'graphile-worker';
import type { TaskList } from 'graphile-worker';
import type { Principal } from '@cogeto/shared';
import { BULK_OUTDATE_ACTION } from '@cogeto/shared';
import { idempotentTask } from '../infrastructure/index';
import { startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { createMemoryStore } from '../memory/index';
import type { MemoryStore } from '../memory/index';
import { ActionRegistry } from './action-registry';
import { ApprovalService } from './approval.service';
import { ApprovalExecutor } from './approval.executor';
import { APPROVAL_EXECUTE_JOB_TYPE, checkApprovalTransition } from './domain/approval-machine';

const userA: Principal = {
  userId: 'user-a',
  name: 'User A',
  email: null,
  orgId: 'org-1',
  orgName: 'Org One',
  roles: [],
};
// A different org — the confirm authorization gate must refuse them.
const userB: Principal = {
  userId: 'user-b',
  name: 'User B',
  email: null,
  orgId: 'org-2',
  orgName: 'Org Two',
  roles: [],
};
// A SECOND user in userA's org — a teammate. Content-bearing approvals (reply
// drafts) must hide their content from them and refuse their confirm (SEC-5).
const userA2: Principal = {
  userId: 'user-a2',
  name: 'User A2',
  email: null,
  orgId: 'org-1',
  orgName: 'Org One',
  roles: [],
};

describe('approval state machine (integration: real Postgres + Qdrant)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;
  let service: ApprovalService;
  let executor: ApprovalExecutor;

  beforeAll(async () => {
    // Real Qdrant since QS-26: the approved bulk-outdate transitions memories,
    // and transitions now REQUIRE the vector store (no silent payload skip).
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    store = createMemoryStore({
      db: tdb.db,
      qdrant: {
        url: qdrant.url,
        embeddingModel: 'test-embed',
        dimensions: 8,
        collection: 'approvals-spec',
      },
    });
    await store.ensureIndexReady();
    const registry = new ActionRegistry(store);
    service = new ApprovalService(tdb.db, registry);
    executor = new ApprovalExecutor(registry);
  }, 120_000);
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  // ── Harness ──────────────────────────────────────────────────────────────

  const taskList = (): TaskList => ({
    [APPROVAL_EXECUTE_JOB_TYPE]: idempotentTask(
      tdb.db,
      APPROVAL_EXECUTE_JOB_TYPE,
      async (tx, payload) => {
        // Return the after-commit thunk (QS-27) so the deferred Qdrant payload
        // sync runs once the transaction commits, exactly as the worker does.
        return (await executor.execute(tx, payload.source_id)).afterCommit;
      },
    ),
  });
  /** The Qdrant point's stored status payload, via plain REST (memory owns the client). */
  const pointStatus = async (id: string): Promise<string | undefined> => {
    const response = await fetch(`${qdrant.url}/collections/approvals-spec/points/${id}`);
    if (!response.ok) return undefined;
    const body = (await response.json()) as { result?: { payload?: { status?: string } } };
    return body.result?.payload?.status;
  };
  const runWorker = () => runOnce({ pgPool: tdb.pool, taskList: taskList() });
  const enqueueExecute = (approvalId: string) =>
    tdb.pool.query(`SELECT graphile_worker.add_job($1, payload := $2::json)`, [
      APPROVAL_EXECUTE_JOB_TYPE,
      JSON.stringify({ source_type: 'approval', source_id: approvalId }),
    ]);

  const makeMemory = async (
    principal: Principal,
    status: 'active' | 'user_approved',
  ): Promise<string> => {
    const row = await store.createFromFact(principal, {
      content: `fact ${randomUUID()}`,
      scope: 'private',
      sourceType: 'user_note',
      sourceId: randomUUID(),
      initialStatus: status === 'user_approved' ? 'uncertain' : 'active',
    });
    if (status === 'user_approved') {
      await store.transition({ kind: 'user', userId: principal.userId }, row.id, 'user_approved');
    }
    return row.id;
  };
  const statusOf = async (id: string): Promise<string> => {
    const { rows } = await tdb.pool.query<{ status: string }>(
      'SELECT status FROM memory WHERE id = $1',
      [id],
    );
    return rows[0]!.status;
  };
  const approvalStatus = async (id: string): Promise<string> => {
    const { rows } = await tdb.pool.query<{ status: string }>(
      'SELECT status FROM approval WHERE id = $1',
      [id],
    );
    return rows[0]?.status ?? 'MISSING';
  };
  const auditCount = async (action: string, entityId: string): Promise<number> => {
    const { rows } = await tdb.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM audit_log WHERE action = $1 AND entity_id = $2',
      [action, entityId],
    );
    return Number(rows[0]!.n);
  };

  // ── Tests ──────────────────────────────────────────────────────────────────

  it('bulk_action_effect: the wired action changes exactly the eligible targets, skips user_approved, is reversible', async () => {
    const m1 = await makeMemory(userA, 'active');
    const m2 = await makeMemory(userA, 'active');
    const blessed = await makeMemory(userA, 'user_approved');

    const approval = await service.create(userA, BULK_OUTDATE_ACTION, {
      memoryIds: [m1, m2, blessed],
    });
    await service.confirm(userA, approval.id, 'approve');
    await runWorker();

    expect(await statusOf(m1)).toBe('outdated');
    expect(await statusOf(m2)).toBe('outdated');
    expect(await statusOf(blessed)).toBe('user_approved'); // explicit blessing untouched
    expect(await approvalStatus(approval.id)).toBe('executed');

    const detail = await service.get(userA, approval.id);
    expect(detail.result).toBe('Marked 2 outdated, skipped 1');

    // Reversible: the owner can re-affirm a wrongly-outdated memory.
    await store.transition({ kind: 'user', userId: userA.userId }, m1, 'active');
    expect(await statusOf(m1)).toBe('active');
  });

  it('bulk_outdate_syncs_qdrant_after_commit (QS-27): the bulk effect defers the per-row Qdrant payload sync to after the transaction, and the points end outdated', async () => {
    const m1 = await makeMemory(userA, 'active');
    const m2 = await makeMemory(userA, 'active');
    // Give the memories real Qdrant points so the payload sync is observable
    // (createFromFact does not embed — embedding is a separate step).
    const rows = await store.getManyForPrincipal(userA, [m1, m2], { includeSensitive: true });
    await store.upsertVectors(
      rows,
      rows.map(() => Array.from({ length: 8 }, () => 0)),
    );
    expect(await pointStatus(m1)).toBe('active'); // upserted with the row's current status

    const approval = await service.create(userA, BULK_OUTDATE_ACTION, { memoryIds: [m1, m2] });
    await service.confirm(userA, approval.id, 'approve');
    await runWorker();

    // PG committed the transition; the deferred after-commit step then synced
    // the Qdrant payloads (QS-27) — no row lock was held across those calls.
    expect(await statusOf(m1)).toBe('outdated');
    expect(await pointStatus(m1)).toBe('outdated');
    expect(await pointStatus(m2)).toBe('outdated');
  });

  it('approval_worker_only: confirm(approve) transitions state but runs NO effect; only the worker executes', async () => {
    const m = await makeMemory(userA, 'active');
    const approval = await service.create(userA, BULK_OUTDATE_ACTION, { memoryIds: [m] });
    await service.confirm(userA, approval.id, 'approve');

    // The app-side confirm did NOT touch the memory — no effect outside the worker.
    expect(await approvalStatus(approval.id)).toBe('approved');
    expect(await statusOf(m)).toBe('active');
    expect(await auditCount('approval.executed', approval.id)).toBe(0);

    await runWorker(); // only now does the effect run
    expect(await statusOf(m)).toBe('outdated');
    expect(await approvalStatus(approval.id)).toBe('executed');
  });

  it('approval_execute_only_from_approved: execution from any non-approved state is impossible (API + worker)', async () => {
    // pending → cannot execute.
    const m = await makeMemory(userA, 'active');
    const pending = await service.create(userA, BULK_OUTDATE_ACTION, { memoryIds: [m] });
    await expect(tdb.db.transaction((tx) => executor.execute(tx, pending.id))).rejects.toThrow(
      /in state pending_approval/,
    );

    // Worker path: a manually-enqueued execute for a pending approval fails and
    // changes nothing (job errors out; memory untouched, approval still pending).
    await enqueueExecute(pending.id);
    await runWorker();
    expect(await statusOf(m)).toBe('active');
    expect(await approvalStatus(pending.id)).toBe('pending_approval');

    // rejected → cannot execute.
    const rejected = await service.create(userA, BULK_OUTDATE_ACTION, { memoryIds: [m] });
    await service.confirm(userA, rejected.id, 'reject');
    await expect(tdb.db.transaction((tx) => executor.execute(tx, rejected.id))).rejects.toThrow(
      /in state rejected/,
    );

    // executed → cannot be re-approved (terminal in the machine).
    const done = await service.create(userA, BULK_OUTDATE_ACTION, { memoryIds: [m] });
    await service.confirm(userA, done.id, 'approve');
    await runWorker();
    expect(await approvalStatus(done.id)).toBe('executed');
    await expect(service.confirm(userA, done.id, 'approve')).rejects.toThrow(/terminal|illegal/i);
    expect(checkApprovalTransition('executed', 'approved').allowed).toBe(false);
  });

  it('approval_idempotent: a duplicate execution delivery runs the effect exactly once', async () => {
    const m1 = await makeMemory(userA, 'active');
    const m2 = await makeMemory(userA, 'active');
    const approval = await service.create(userA, BULK_OUTDATE_ACTION, { memoryIds: [m1, m2] });
    await service.confirm(userA, approval.id, 'approve'); // enqueues execute #1
    await runWorker();
    expect(await auditCount('approval.executed', approval.id)).toBe(1);

    // Re-deliver the same job: the S1-B guard claims nothing (key exists) and
    // the executor would also no-op an already-executed row.
    await enqueueExecute(approval.id);
    await runWorker();
    expect(await auditCount('approval.executed', approval.id)).toBe(1); // still exactly once
    expect(await statusOf(m1)).toBe('outdated');
    expect(await statusOf(m2)).toBe('outdated');
  });

  it('approval_concurrent_confirm (QS-30): two parallel approves — one wins, the effect runs exactly once', async () => {
    const m = await makeMemory(userA, 'active');
    const approval = await service.create(userA, BULK_OUTDATE_ACTION, { memoryIds: [m] });

    // Fire two approve-confirms concurrently. `confirm` locks the row FOR UPDATE
    // before checking the transition, so they SERIALIZE: exactly one takes
    // pending_approval → approved (and enqueues the single execute job); the
    // other, re-reading the now-approved row under READ COMMITTED, fails the
    // approved→approved transition and rejects. No double-approve, no double
    // enqueue.
    const results = await Promise.allSettled([
      service.confirm(userA, approval.id, 'approve'),
      service.confirm(userA, approval.id, 'approve'),
    ]);
    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(await approvalStatus(approval.id)).toBe('approved');
    // Exactly ONE approved transition was recorded (single winner).
    expect(await auditCount('approval.approved', approval.id)).toBe(1);

    // The worker then runs the effect exactly once, end to end.
    await runWorker();
    expect(await statusOf(m)).toBe('outdated');
    expect(await approvalStatus(approval.id)).toBe('executed');
    expect(await auditCount('approval.executed', approval.id)).toBe(1);
  });

  it('approval_expiry: an expired approval cannot execute', async () => {
    const m = await makeMemory(userA, 'active');
    const approval = await service.create(userA, BULK_OUTDATE_ACTION, { memoryIds: [m] });
    // Fast-forward its deadline into the past, then run the scheduled pass.
    await tdb.pool.query(
      `UPDATE approval SET expires_at = now() - interval '1 hour' WHERE id = $1`,
      [approval.id],
    );
    const expired = await service.expireStale();
    expect(expired).toBeGreaterThanOrEqual(1);
    expect(await approvalStatus(approval.id)).toBe('expired');
    expect(await auditCount('approval.expired', approval.id)).toBe(1);

    // An expired approval can never run.
    await expect(tdb.db.transaction((tx) => executor.execute(tx, approval.id))).rejects.toThrow(
      /in state expired/,
    );
    expect(await statusOf(m)).toBe('active');

    // A second expiry pass finds nothing new (idempotent).
    await service.expireStale();
    expect(await auditCount('approval.expired', approval.id)).toBe(1);
  });

  it('approval_authz: another org cannot see, confirm, or target this org’s approvals', async () => {
    const m = await makeMemory(userA, 'active');
    const approval = await service.create(userA, BULK_OUTDATE_ACTION, { memoryIds: [m] });

    // Foreign org: confirm and read both 404 (existence must not leak).
    await expect(service.confirm(userB, approval.id, 'approve')).rejects.toThrow(/not found/i);
    await expect(service.get(userB, approval.id)).rejects.toThrow(/not found/i);
    expect(await service.listPending(userB)).toHaveLength(0);
    expect(await approvalStatus(approval.id)).toBe('pending_approval'); // untouched

    // Foreign org cannot even create an approval over another user's memories.
    await expect(service.create(userB, BULK_OUTDATE_ACTION, { memoryIds: [m] })).rejects.toThrow(
      /not yours/i,
    );
  });

  it('approval_audited: every transition writes exactly one audit row', async () => {
    const m = await makeMemory(userA, 'active');

    // created → approved → executed
    const a = await service.create(userA, BULK_OUTDATE_ACTION, { memoryIds: [m] });
    expect(await auditCount('approval.created', a.id)).toBe(1);
    await service.confirm(userA, a.id, 'approve');
    expect(await auditCount('approval.approved', a.id)).toBe(1);
    await runWorker();
    expect(await auditCount('approval.executed', a.id)).toBe(1);

    // a rejected one
    const r = await service.create(userA, BULK_OUTDATE_ACTION, { memoryIds: [m] });
    await service.confirm(userA, r.id, 'reject');
    expect(await auditCount('approval.rejected', r.id)).toBe(1);

    // an expired one
    const e = await service.create(userA, BULK_OUTDATE_ACTION, { memoryIds: [m] });
    await tdb.pool.query(
      `UPDATE approval SET expires_at = now() - interval '1 hour' WHERE id = $1`,
      [e.id],
    );
    await service.expireStale();
    expect(await auditCount('approval.expired', e.id)).toBe(1);
  });

  it('reply_draft_owner_gated (SEC-5): a teammate sees no content and cannot confirm a reply draft', async () => {
    const payload = {
      to: 'ana@adriatic-foods.hr',
      recipientResolved: true,
      recipientVerified: true,
      subject: 'Re: Delivery schedule',
      inReplyTo: null,
      references: [],
      body: 'Hi Ana,\nConfirming Friday works.\nBest,\nUser A',
      emailSourceId: randomUUID(),
    };
    const draft = await service.create(userA, 'email.reply_draft', payload);

    // The requester sees the body preview.
    const own = (await service.listPending(userA)).find((a) => a.id === draft.id)!;
    expect(own.preview.join('\n')).toContain('Confirming Friday works');
    expect(own.summary).toContain('Draft reply to ana@adriatic-foods.hr');

    // A same-org teammate sees the item but NO content — a placeholder only.
    const teammate = (await service.listPending(userA2)).find((a) => a.id === draft.id)!;
    expect(teammate).toBeDefined();
    expect(teammate.preview.join('\n')).not.toContain('Confirming Friday works');
    expect(teammate.summary).not.toContain('ana@adriatic-foods.hr');
    expect(teammate.preview.join('\n')).toMatch(/visible only to the member who requested it/i);

    // The teammate cannot confirm it — it is "not found" for them.
    await expect(service.confirm(userA2, draft.id, 'approve')).rejects.toThrow(/not found/i);
    // The requester can.
    const confirmed = await service.confirm(userA, draft.id, 'approve');
    expect(confirmed.status).toBe('approved');
  });
});
