import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { createMemoryStore } from '../memory/index';
import type { MemoryStore, NewFact } from '../memory/index';
import { ModelGateway, ModelGatewayError } from '../model-gateway/index';
import type { StructuredExtractionRequest } from '../model-gateway/index';
import { TasksEngine } from './tasks.engine';

const principalFor = (userId: string): Principal => ({
  userId,
  name: 'Task Tester',
  email: null,
  orgId: 'org-tasks',
  orgName: 'org-tasks',
  roles: [],
});

/** Judgments scripted at the gateway seam; dispatch by prompt family text. */
class ScriptedJudgeGateway extends ModelGateway {
  closureCalls = 0;
  conditionCalls = 0;
  constructor(
    public closure: () => { verdict: string; reason: string } = () => ({
      verdict: 'unrelated',
      reason: 'scripted',
    }),
    public condition: () => { verdict: string; reason: string } = () => ({
      verdict: 'unrelated',
      reason: 'scripted',
    }),
  ) {
    super();
  }
  complete(): never {
    throw new Error('not used');
  }
  // eslint-disable-next-line require-yield -- not used by the task engine
  async *completeStream(): AsyncIterable<string> {
    throw new Error('not used');
  }
  async embed(): Promise<number[][]> {
    throw new Error('the task engine never embeds');
  }
  embeddingModelId(): string {
    return 'test-embed';
  }
  async extractStructured<T>(schema: ZodType<T>, request: StructuredExtractionRequest): Promise<T> {
    const raw = request.system.includes('FULFILLED')
      ? (this.closureCalls++, this.closure())
      : (this.conditionCalls++, this.condition());
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelGatewayError('scripted output failed schema', false);
    return parsed.data;
  }
}

describe('task engine (integration, real Postgres, scripted judge)', () => {
  let tdb: TestDatabase;
  let store: MemoryStore;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    store = createMemoryStore({ db: tdb.db });
  });
  afterAll(async () => {
    await tdb.stop();
  });

  const engineWith = (gateway: ScriptedJudgeGateway) => new TasksEngine(tdb.db, store, gateway);
  const seed = (owner: string, sourceId: string, fact: Partial<NewFact> & { content: string }) =>
    store.createFromFact(principalFor(owner), {
      scope: 'private',
      sourceType: 'user_note',
      sourceId,
      entities: [],
      ...fact,
    } as NewFact);
  const run = (engine: TasksEngine, sourceId: string) =>
    tdb.db.transaction((tx) => engine.processSource(tx, 'user_note', sourceId));
  const auditCount = async (action: string, entityId: string) => {
    const { rows } = await tdb.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = $1 AND entity_id = $2`,
      [action, entityId],
    );
    return Number(rows[0]!.n);
  };

  it('derivation_deterministic: commitment → exactly one task, correct mapping, idempotent re-run', async () => {
    const owner = `task-derive-${randomUUID()}`;
    const source = randomUUID();
    const gateway = new ScriptedJudgeGateway();
    const engine = engineWith(gateway);

    await seed(owner, source, {
      content: 'You will send Luka the revised offer after Luka confirms the budget.',
      kind: 'commitment',
      entities: ['Luka'],
      subjectEntity: 'Luka',
      validUntil: new Date('2026-07-20T00:00:00Z'),
    });
    await seed(owner, source, {
      content: 'The kickoff went well.', // kind fact — never derives
      kind: 'fact',
      entities: ['Luka'],
    });

    const first = await run(engine, source);
    expect(first.derived).toBe(1);
    const tasks = await engine.listForPrincipal(principalFor(owner));
    expect(tasks).toHaveLength(1);
    const t = tasks[0]!;
    expect(t.title).toContain('revised offer');
    expect(t.primaryPerson).toBe('Luka');
    expect(t.conditionText).toMatch(/after Luka confirms the budget/i);
    expect(t.status).toBe('blocked_on_condition');
    expect(t.due?.toISOString()).toBe('2026-07-20T00:00:00.000Z');
    expect(await auditCount('task.derived', t.id)).toBe(1);

    // Idempotent re-run (re-delivered job): nothing new, nothing changed.
    const second = await run(engine, source);
    expect(second.derived).toBe(0);
    expect(await engine.listForPrincipal(principalFor(owner))).toHaveLength(1);
    // The scripted judge was never asked to close the deriving commitment
    // against itself (self-pairs excluded); the fact-kind memory found no
    // sharing task other than Luka's — verdicts were unrelated, no actions.
  });

  it('supersession_repoints: editing the deriving memory moves the task to the chain head, no duplicate', async () => {
    const owner = `task-repoint-${randomUUID()}`;
    const source = randomUUID();
    const engine = engineWith(new ScriptedJudgeGateway());

    const memory = await seed(owner, source, {
      content: 'You will prepare the Atlas risk register.',
      kind: 'commitment',
      entities: ['Atlas'],
    });
    await run(engine, source);
    const before = (await engine.listForPrincipal(principalFor(owner)))[0]!;
    expect(before.derivedFromMemoryId).toBe(memory.id);

    // Edit = supersession (0006 r3); the successor keeps provenance and kind.
    const { successor } = await store.editContent(
      principalFor(owner),
      memory.id,
      'You will prepare and circulate the Atlas risk register.',
    );
    await run(engine, source);

    const after = await engine.listForPrincipal(principalFor(owner));
    expect(after).toHaveLength(1); // repointed, never duplicated
    expect(after[0]!.id).toBe(before.id);
    expect(after[0]!.derivedFromMemoryId).toBe(successor.id);
    expect(after[0]!.title).toContain('circulate');
    expect(await auditCount('task.repointed', before.id)).toBe(1);
  });

  it('condition_flow: a satisfied verdict flips blocked_on_condition → open, audited', async () => {
    const owner = `task-cond-${randomUUID()}`;
    const gateway = new ScriptedJudgeGateway(
      () => ({ verdict: 'unrelated', reason: 'scripted' }),
      () => ({ verdict: 'satisfied', reason: 'the budget was confirmed' }),
    );
    const engine = engineWith(gateway);

    const s1 = randomUUID();
    await seed(owner, s1, {
      content: 'Send Luka the revised offer after Luka confirms the budget.',
      kind: 'commitment',
      entities: ['Luka'],
    });
    await run(engine, s1);
    const blocked = (await engine.listForPrincipal(principalFor(owner)))[0]!;
    expect(blocked.status).toBe('blocked_on_condition');

    const s2 = randomUUID();
    const confirming = await seed(owner, s2, {
      content: 'Luka confirmed the budget for the second phase.',
      kind: 'fact',
      entities: ['Luka'],
    });
    const report = await run(engine, s2);
    expect(report.conditionsMet).toBe(1);
    const after = (await engine.listForPrincipal(principalFor(owner)))[0]!;
    expect(after.status).toBe('open');
    expect(after.conditionMet).toBe(true);
    expect(after.conditionMetByMemoryId).toBe(confirming.id);
    expect(await auditCount('task.condition_met', after.id)).toBe(1);
  });

  it('closure_flow: a closes verdict sets done with closed_by_memory_id, audited', async () => {
    const owner = `task-close-${randomUUID()}`;
    const gateway = new ScriptedJudgeGateway(() => ({
      verdict: 'closes',
      reason: 'the offer was sent',
    }));
    const engine = engineWith(gateway);

    const s1 = randomUUID();
    await seed(owner, s1, {
      content: 'You will send Marko the updated proposal.',
      kind: 'commitment',
      entities: ['Marko'],
    });
    await run(engine, s1);

    const s2 = randomUUID();
    const closing = await seed(owner, s2, {
      content: 'Sent Marko the updated proposal this afternoon.',
      kind: 'fact',
      entities: ['Marko'],
    });
    const report = await run(engine, s2);
    expect(report.closed).toBe(1);

    const settled = await engine.listForPrincipal(principalFor(owner), { includeSettled: true });
    expect(settled).toHaveLength(1);
    expect(settled[0]!.status).toBe('done');
    expect(settled[0]!.closedByMemoryId).toBe(closing.id);
    expect(await auditCount('task.closed', settled[0]!.id)).toBe(1);
    // Gone from the open list — the open-loops answer will not show it.
    expect(await engine.listForPrincipal(principalFor(owner))).toHaveLength(0);

    // Re-delivery: the settled task left the candidate pool; nothing changes.
    const again = await run(engine, s2);
    expect(again.closed).toBe(0);
  });

  it('no_false_close_bias: progresses/related verdicts change nothing', async () => {
    const owner = `task-bias-${randomUUID()}`;
    const gateway = new ScriptedJudgeGateway(
      () => ({ verdict: 'progresses', reason: 'a draft exists' }),
      () => ({ verdict: 'not_satisfied', reason: 'only scheduled' }),
    );
    const engine = engineWith(gateway);

    const s1 = randomUUID();
    await seed(owner, s1, {
      content: 'Send Luka the revised offer after Luka confirms the budget.',
      kind: 'commitment',
      entities: ['Luka'],
    });
    await run(engine, s1);

    const s2 = randomUUID();
    await seed(owner, s2, {
      content: 'Luka said the budget discussion is on Thursday’s agenda.',
      kind: 'fact',
      entities: ['Luka'],
    });
    const report = await run(engine, s2);
    expect(report.closed).toBe(0);
    expect(report.conditionsMet).toBe(0);
    const t = (await engine.listForPrincipal(principalFor(owner)))[0]!;
    expect(t.status).toBe('blocked_on_condition');
    expect(t.conditionMet).toBe(false);
    expect(gateway.closureCalls).toBeGreaterThan(0); // it DID ask — and held
  });

  it('open_loops_gated: user B’s tasks never appear in A’s list', async () => {
    const ownerA = `task-gate-a-${randomUUID()}`;
    const ownerB = `task-gate-b-${randomUUID()}`;
    const engine = engineWith(new ScriptedJudgeGateway());

    const sA = randomUUID();
    await seed(ownerA, sA, {
      content: 'A will call Vera.',
      kind: 'commitment',
      entities: ['Vera'],
    });
    await run(engine, sA);
    const sB = randomUUID();
    await seed(ownerB, sB, {
      content: 'B will email Vera.',
      kind: 'commitment',
      entities: ['Vera'],
    });
    await run(engine, sB);

    const aTasks = await engine.listForPrincipal(principalFor(ownerA));
    expect(aTasks).toHaveLength(1);
    expect(aTasks[0]!.title).toContain('A will call');
    const bTasks = await engine.listForPrincipal(principalFor(ownerB));
    expect(bTasks).toHaveLength(1);
    expect(bTasks[0]!.title).toContain('B will email');
  });

  it('user operations: reopen/dismiss/complete are audited and owner-checked', async () => {
    const owner = `task-ops-${randomUUID()}`;
    const engine = engineWith(new ScriptedJudgeGateway());
    const s = randomUUID();
    await seed(owner, s, { content: 'You will file the report.', kind: 'commitment' });
    await run(engine, s);
    const t = (await engine.listForPrincipal(principalFor(owner)))[0]!;

    await engine.complete(principalFor(owner), t.id);
    expect(await auditCount('task.done', t.id)).toBe(1);
    await engine.reopen(principalFor(owner), t.id);
    expect(await auditCount('task.open', t.id)).toBe(1);
    await engine.dismiss(principalFor(owner), t.id);
    expect(await auditCount('task.dismissed', t.id)).toBe(1);
    // Another user cannot touch it — reported as not-found, no existence leak.
    await expect(engine.reopen(principalFor('someone-else'), t.id)).rejects.toThrow(/not found/);
  });

  const setDue = (taskId: string, due: Date | null) =>
    tdb.pool.query(`UPDATE task SET due = $2 WHERE id = $1`, [taskId, due]);
  const setDormant = (taskId: string, dormant: boolean) =>
    tdb.pool.query(`UPDATE task SET dormant = $2 WHERE id = $1`, [taskId, dormant]);

  it('reminder_idempotent: a re-run raises no duplicate reminder for the same task and window', async () => {
    const owner = `task-rem-idem-${randomUUID()}`;
    const engine = engineWith(new ScriptedJudgeGateway());
    const s = randomUUID();
    await seed(owner, s, { content: 'You will submit the grant application.', kind: 'commitment' });
    await run(engine, s);
    const t = (await engine.listForPrincipal(principalFor(owner)))[0]!;
    await setDue(t.id, new Date(Date.now() - 24 * 3600 * 1000)); // overdue
    await setDormant(t.id, true);

    await engine.runReminders();
    const stamped = (await engine.listForPrincipal(principalFor(owner)))[0]!;
    expect(stamped.dueRemindedAt).not.toBeNull();
    expect(stamped.dormantRemindedAt).not.toBeNull();

    // Re-run the pass: the stamps must NOT move — one reminder per window.
    await engine.runReminders();
    const after = (await engine.listForPrincipal(principalFor(owner)))[0]!;
    expect(after.dueRemindedAt?.getTime()).toBe(stamped.dueRemindedAt?.getTime());
    expect(after.dormantRemindedAt?.getTime()).toBe(stamped.dormantRemindedAt?.getTime());
  });

  it('reminder_clears_on_close: completing a task clears its pending reminders; resolved dormancy clears too', async () => {
    const owner = `task-rem-close-${randomUUID()}`;
    const engine = engineWith(new ScriptedJudgeGateway());
    const s = randomUUID();
    await seed(owner, s, { content: 'You will renew the certificate.', kind: 'commitment' });
    await run(engine, s);
    const t = (await engine.listForPrincipal(principalFor(owner)))[0]!;
    await setDue(t.id, new Date(Date.now() - 24 * 3600 * 1000));
    await setDormant(t.id, true);
    await engine.runReminders();
    expect((await engine.listForPrincipal(principalFor(owner)))[0]!.dueRemindedAt).not.toBeNull();

    await engine.complete(principalFor(owner), t.id);
    const settled = (
      await engine.listForPrincipal(principalFor(owner), { includeSettled: true })
    ).find((row) => row.id === t.id)!;
    expect(settled.dueRemindedAt).toBeNull();
    expect(settled.dormantRemindedAt).toBeNull();
  });

  it('reminder_resolved_dormancy_clears: a dormant reminder is dropped once the task is no longer quiet', async () => {
    const owner = `task-rem-dorm-${randomUUID()}`;
    const engine = engineWith(new ScriptedJudgeGateway());
    const s = randomUUID();
    await seed(owner, s, { content: 'You will circulate the notes.', kind: 'commitment' });
    await run(engine, s);
    const t = (await engine.listForPrincipal(principalFor(owner)))[0]!;
    await setDormant(t.id, true);
    await engine.runReminders();
    expect(
      (await engine.listForPrincipal(principalFor(owner)))[0]!.dormantRemindedAt,
    ).not.toBeNull();

    await setDormant(t.id, false); // the engine's dormancy sync flipped it back
    await engine.runReminders();
    expect((await engine.listForPrincipal(principalFor(owner)))[0]!.dormantRemindedAt).toBeNull();
  });

  it('tasks_ui_actions_audited: reopen/dismiss/complete each write exactly one audit row through the engine', async () => {
    const owner = `task-audit-${randomUUID()}`;
    const engine = engineWith(new ScriptedJudgeGateway());
    const s = randomUUID();
    await seed(owner, s, { content: 'You will book the venue.', kind: 'commitment' });
    await run(engine, s);
    const t = (await engine.listForPrincipal(principalFor(owner)))[0]!;

    await engine.complete(principalFor(owner), t.id);
    await engine.reopen(principalFor(owner), t.id);
    await engine.dismiss(principalFor(owner), t.id);
    // Exactly one audit row per operation — no double-writes, no missing rows.
    expect(await auditCount('task.done', t.id)).toBe(1);
    expect(await auditCount('task.open', t.id)).toBe(1);
    expect(await auditCount('task.dismissed', t.id)).toBe(1);
  });

  it('task_badge_counts: the badge equals open + blocked, gated to the Principal', async () => {
    const owner = `task-badge-${randomUUID()}`;
    const other = `task-badge-other-${randomUUID()}`;
    const engine = engineWith(new ScriptedJudgeGateway());

    const s1 = randomUUID();
    await seed(owner, s1, { content: 'You will draft the memo.', kind: 'commitment' });
    const s2 = randomUUID();
    await seed(owner, s2, {
      content: 'Send Ivo the invoice after Ivo returns the signed form.',
      kind: 'commitment',
      entities: ['Ivo'],
    });
    const s3 = randomUUID();
    await seed(owner, s3, { content: 'You will archive the tickets.', kind: 'commitment' });
    await run(engine, s1);
    await run(engine, s2);
    await run(engine, s3);
    // Another owner's task never counts toward this Principal's badge.
    const sOther = randomUUID();
    await seed(other, sOther, { content: 'Other will call the bank.', kind: 'commitment' });
    await run(engine, sOther);

    expect(await engine.countOpenForPrincipal(principalFor(owner))).toBe(3); // 2 open + 1 blocked
    const archive = (await engine.listForPrincipal(principalFor(owner))).find((t) =>
      t.title.includes('archive'),
    )!;
    await engine.complete(principalFor(owner), archive.id);
    expect(await engine.countOpenForPrincipal(principalFor(owner))).toBe(2);
    expect(await engine.countOpenForPrincipal(principalFor(other))).toBe(1);
  });

  it('tasks_read_only_memory: the tasks module calls no mutating memory interface and no memory internals', () => {
    const tasksDir = path.resolve(__dirname);
    const sources = readdirSync(tasksDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
      .map((f) => readFileSync(path.join(tasksDir, f), 'utf8'))
      .join('\n');
    // No memory internals — only the public barrel.
    expect(sources).not.toMatch(/from '\.\.\/memory\/(?!index)/);
    // No mutating memory-aggregate calls, ever (decision 0013's prime rule).
    const mutators = [
      'transition(',
      'transitionInTx(',
      'supersede(',
      'supersedeInTx(',
      'editContent(',
      'editContentInTx(',
      'createFromFact(',
      'admitExtractedFact(',
      'toggleSensitive(',
      'rejectUncertain(',
      'mergeSameFact(',
      'createContradiction(',
      'applySupersession(',
      'resolveContradiction(',
      'upsertVectors(',
    ];
    for (const call of mutators) {
      expect(
        sources.includes(`memoryStore.${call}`),
        `tasks must not call MemoryStore.${call}`,
      ).toBe(false);
    }
  });
});
