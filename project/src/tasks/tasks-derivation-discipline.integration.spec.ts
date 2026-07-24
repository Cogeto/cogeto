import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { createMemoryStore } from '../memory/index';
import type { MemoryRow, MemoryStore, NewFact, SourceType } from '../memory/index';
import { isolateEmailContentDetailed } from '../ingestion/index';
import { ModelGateway, ModelGatewayError } from '../model-gateway/index';
import type { StructuredExtractionRequest } from '../model-gateway/index';
import { TasksEngine } from './tasks.engine';
import { task, taskConclusion } from './persistence/tables';
import { firstPersonSource, runDerivationTrapEval } from './derivation-rule';

const principalFor = (userId: string): Principal => ({
  userId,
  name: 'Discipline Tester',
  email: null,
  orgId: 'org-discipline',
  orgName: 'org-discipline',
  roles: [],
});

/** Judgments scripted at the gateway seam; dispatch by prompt family text. */
class ScriptedJudgeGateway extends ModelGateway {
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
    const raw = request.system.includes('FULFILLED') ? this.closure() : this.condition();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelGatewayError('scripted output failed schema', false);
    return parsed.data;
  }
}

describe('task-derivation discipline (P6.5, decision 0054; real Postgres + Qdrant)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    store = createMemoryStore({
      db: tdb.db,
      qdrant: {
        url: qdrant.url,
        embeddingModel: 'test-embed',
        dimensions: 8,
        collection: 'discipline-spec',
      },
    });
    await store.ensureIndexReady();
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  const engineWith = (gateway = new ScriptedJudgeGateway()) =>
    new TasksEngine(tdb.db, store, gateway);
  const seed = (
    owner: string,
    sourceType: SourceType,
    sourceId: string,
    fact: Partial<NewFact> & { content: string },
  ) =>
    store.createFromFact(principalFor(owner), {
      scope: 'private',
      sourceType,
      sourceId,
      entities: [],
      kind: 'commitment',
      ...fact,
    } as NewFact);
  const run = (engine: TasksEngine, sourceType: SourceType, sourceId: string) =>
    tdb.db.transaction((tx) => engine.processSource(tx, sourceType, sourceId));
  const tasksOf = (engine: TasksEngine, owner: string) =>
    engine.listForPrincipal(principalFor(owner), { includeSettled: true });
  const auditCount = async (action: string, entityId: string) => {
    const { rows } = await tdb.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = $1 AND entity_id = $2`,
      [action, entityId],
    );
    return Number(rows[0]!.n);
  };
  /** Simulates a PRE-0054 phantom: a task row the old rule would have derived.
   * Test-only — production task writes stay engine-only (F3 handoff §6). */
  const insertLegacyTask = async (row: MemoryRow, adopted = false): Promise<string> => {
    const [inserted] = await tdb.db
      .insert(task)
      .values({
        ownerId: row.ownerId,
        scope: row.scope,
        derivedFromMemoryId: row.id,
        title: (row.content ?? '').trim(),
        entities: row.entities,
        adopted,
      })
      .returning({ id: task.id });
    return inserted!.id;
  };

  it('derive_notes_chat_only_plus_own_email: the first-person matrix across source types', async () => {
    const owner = `matrix-${randomUUID()}`;
    const engine = engineWith();

    const cases: Array<{ sourceType: SourceType; authoredByUser?: boolean; derives: boolean }> = [
      { sourceType: 'user_note', derives: true },
      { sourceType: 'chat', derives: true },
      { sourceType: 'email', authoredByUser: true, derives: true },
      { sourceType: 'email', authoredByUser: false, derives: false },
      { sourceType: 'file', derives: false },
      { sourceType: 'web', derives: false },
      { sourceType: 'calendar_event', derives: false },
      { sourceType: 'task_conclusion', derives: false },
    ];
    let expected = 0;
    for (const c of cases) {
      const sourceId = randomUUID();
      await seed(owner, c.sourceType, sourceId, {
        content: `I will send the ${c.sourceType} report (${sourceId.slice(0, 8)})`,
        authoredByUser: c.authoredByUser,
      });
      const report = await run(engine, c.sourceType, sourceId);
      expect(report.derived, `${c.sourceType} authoredByUser=${String(c.authoredByUser)}`).toBe(
        c.derives ? 1 : 0,
      );
      if (c.derives) expected += 1;
    }
    expect(await tasksOf(engine, owner)).toHaveLength(expected);

    // The backfill respects the SAME rule — it must not resurrect what the
    // live path refused (pre-0054 it bypassed the guard entirely).
    const backfill = await engine.backfill();
    expect(backfill.derived).toBe(0);
    expect(await tasksOf(engine, owner)).toHaveLength(expected);
  });

  it('email_quoted_never_derives: a forwarded original or quoted-only body is not first-person', async () => {
    // The structural half the SourceReader computes: a forwarded original's
    // inner content and a quoted-only body are someone else's words.
    const forwarded = isolateEmailContentDetailed(
      'FYI\n\n---------- Forwarded message ----------\nFrom: Ana Kovač <ana@adriatic-foods.hr>\nSubject: Annex\n\nI will send the signed annex by Friday.',
    );
    expect(forwarded.forwarded).toBe(true);
    expect(forwarded.content).toContain('signed annex');
    const quotedOnly = isolateEmailContentDetailed(
      'On Mon, 20 Jul 2026, Ana wrote:\n> I will send the signed annex by Friday.',
    );
    expect(quotedOnly.quotedFallback).toBe(true);

    // Either shape yields authoredByUser=false — the memory exists, no task.
    const owner = `quoted-${randomUUID()}`;
    const engine = engineWith();
    const sourceId = randomUUID();
    const memory = await seed(owner, 'email', sourceId, {
      content: 'Ana Kovač will send the signed annex by Friday.',
      authoredByUser: false,
      entities: ['Ana Kovač'],
    });
    const report = await run(engine, 'email', sourceId);
    expect(report.derived).toBe(0);
    expect(await tasksOf(engine, owner)).toHaveLength(0);
    // Still a full memory: extracted, stored, retrievable.
    expect((await store.getManySystem([memory.id]))[0]?.content).toContain('signed annex');
  });

  it('inbound_sender_commitment: a sender promise creates no task but can satisfy a condition', async () => {
    const owner = `inbound-${randomUUID()}`;
    // The user's OWN blocked task (from a note), waiting on Marko's export.
    const noteSource = randomUUID();
    const engine = engineWith(
      new ScriptedJudgeGateway(
        () => ({ verdict: 'unrelated', reason: 'scripted' }),
        () => ({ verdict: 'satisfied', reason: 'scripted' }),
      ),
    );
    await seed(owner, 'user_note', noteSource, {
      content: 'I will reconcile the numbers once Marko sends the export.',
      entities: ['Marko'],
      subjectEntity: 'Marko',
    });
    await run(engine, 'user_note', noteSource);
    let tasks = await tasksOf(engine, owner);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe('blocked_on_condition');

    // Marko's inbound promise/fact (allowlist-routed → not user-authored):
    // it becomes a memory, derives nothing, and satisfies the condition.
    const emailSource = randomUUID();
    await seed(owner, 'email', emailSource, {
      content: 'Marko sent the export on Tuesday.',
      authoredByUser: false,
      entities: ['Marko'],
    });
    const report = await run(engine, 'email', emailSource);
    expect(report.derived).toBe(0);
    expect(report.conditionsMet).toBe(1);
    tasks = await tasksOf(engine, owner);
    expect(tasks).toHaveLength(1); // still only the user's task
    expect(tasks[0]!.status).toBe('open');
    expect(tasks[0]!.conditionMet).toBe(true);
  });

  it('authorship_uncertain_no_derive: unknown email authorship (NULL) never derives', async () => {
    const owner = `unknown-${randomUUID()}`;
    const engine = engineWith();
    const sourceId = randomUUID();
    await seed(owner, 'email', sourceId, {
      content: 'I will confirm the venue tomorrow.',
      // authoredByUser omitted → NULL: provenance cannot determine authorship.
    });
    expect(firstPersonSource({ sourceType: 'email', authoredByUser: null })).toBe(false);
    const report = await run(engine, 'email', sourceId);
    expect(report.derived).toBe(0);
    expect((await engine.backfill()).derived).toBe(0);
    expect(await tasksOf(engine, owner)).toHaveLength(0);
  });

  it('conditions_still_source_agnostic: a web fact closes an existing task', async () => {
    const owner = `agnostic-${randomUUID()}`;
    const engine = engineWith(
      new ScriptedJudgeGateway(() => ({ verdict: 'closes', reason: 'scripted' })),
    );
    const noteSource = randomUUID();
    await seed(owner, 'user_note', noteSource, {
      content: 'I will publish the supplier comparison for Adriatic Foods.',
      entities: ['Adriatic Foods'],
    });
    await run(engine, 'user_note', noteSource);

    // The world observed the loop closing: a fetched web page. It derives no
    // task of its own — but it MAY close the user's existing one.
    const webSource = randomUUID();
    await seed(owner, 'web', webSource, {
      content: 'The supplier comparison for Adriatic Foods is now published.',
      kind: 'fact',
      entities: ['Adriatic Foods'],
    });
    const report = await run(engine, 'web', webSource);
    expect(report.derived).toBe(0);
    expect(report.closed).toBe(1);
    const tasks = await tasksOf(engine, owner);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe('done');
  });

  it('adopt_from_memory: adoption derives exactly one task via the engine, audited, correct fields', async () => {
    const owner = `adopt-${randomUUID()}`;
    const principal = principalFor(owner);
    const engine = engineWith();
    const sourceId = randomUUID();
    const memory = await seed(owner, 'file', sourceId, {
      content: 'Ana Kovač must deliver the CRM plan after the sponsor confirms the scope.',
      entities: ['Ana Kovač'],
      subjectEntity: 'Ana Kovač',
      validUntil: new Date('2026-08-15T00:00:00Z'),
    });
    // The rule refused automatic derivation (file source).
    await run(engine, 'file', sourceId);
    expect(await tasksOf(engine, owner)).toHaveLength(0);

    // The user adopts it: one task, through the same structural mapping.
    const adopted = await engine.adoptFromMemory(principal, memory.id);
    expect(adopted.adopted).toBe(true);
    expect(adopted.derivedFromMemoryId).toBe(memory.id);
    expect(adopted.title).toContain('CRM plan');
    expect(adopted.primaryPerson).toBe('Ana Kovač');
    expect(adopted.conditionText).toMatch(/after the sponsor confirms/i);
    expect(adopted.status).toBe('blocked_on_condition');
    expect(adopted.due?.toISOString()).toBe('2026-08-15T00:00:00.000Z');
    expect(await auditCount('task.adopted', adopted.id)).toBe(1);

    // Idempotent: adopting again returns the same task, audits nothing new.
    const again = await engine.adoptFromMemory(principal, memory.id);
    expect(again.id).toBe(adopted.id);
    expect(await auditCount('task.adopted', adopted.id)).toBe(1);
    expect(await tasksOf(engine, owner)).toHaveLength(1);

    // Owner-only: another user's adoption attempt reads as not-found.
    await expect(engine.adoptFromMemory(principalFor('someone-else'), memory.id)).rejects.toThrow(
      /not found/,
    );
  });

  it('adopted_task_full_lifecycle: condition satisfaction, closure, and the conclusion memory', async () => {
    const owner = `adopt-life-${randomUUID()}`;
    const principal = principalFor(owner);
    let conditionMet = false;
    const engine = engineWith(
      new ScriptedJudgeGateway(
        () =>
          conditionMet
            ? { verdict: 'closes', reason: 'scripted' }
            : { verdict: 'unrelated', reason: 'scripted' },
        () => ({ verdict: 'satisfied', reason: 'scripted' }),
      ),
    );
    const memory = await seed(owner, 'web', randomUUID(), {
      content: 'The venue must be booked for Petra once the date is agreed.',
      entities: ['Petra'],
      subjectEntity: 'Petra',
    });
    const adopted = await engine.adoptFromMemory(principal, memory.id);
    expect(adopted.status).toBe('blocked_on_condition');

    // A new note satisfies the condition (engine judgment, source-agnostic).
    const unblockSource = randomUUID();
    await seed(owner, 'user_note', unblockSource, {
      content: 'The date with Petra is agreed.',
      kind: 'fact',
      entities: ['Petra'],
    });
    let report = await run(engine, 'user_note', unblockSource);
    expect(report.conditionsMet).toBe(1);
    conditionMet = true;

    // A later fact closes it; the conclusion row exists (decision 0037).
    const closeSource = randomUUID();
    await seed(owner, 'user_note', closeSource, {
      content: 'The venue for Petra is booked.',
      kind: 'fact',
      entities: ['Petra'],
    });
    report = await run(engine, 'user_note', closeSource);
    expect(report.closed).toBe(1);
    const conclusions = await engine.listConclusionsForPrincipal(principal, adopted.id);
    expect(conclusions.length).toBeGreaterThanOrEqual(2); // condition_met + closed
  });

  it('migration_counts: a seeded mixed state yields exactly the right removals and sparings', async () => {
    const owner = `cleanup-${randomUUID()}`;
    const principal = principalFor(owner);
    const engine = engineWith();

    // Legitimate first-person tasks (kept, never counted).
    const noteSource = randomUUID();
    await seed(owner, 'user_note', noteSource, { content: 'I will call Luka.' });
    await run(engine, 'user_note', noteSource);
    const ownEmailSource = randomUUID();
    await seed(owner, 'email', ownEmailSource, {
      content: 'I will send the annex by Thursday.',
      authoredByUser: true,
    });
    await run(engine, 'email', ownEmailSource);

    // Pre-0054 phantoms (directly inserted legacy rows).
    const phantomOf = async (sourceType: SourceType, content: string, authored?: boolean) =>
      insertLegacyTask(
        await seed(owner, sourceType, randomUUID(), { content, authoredByUser: authored }),
      );
    const webPhantom = await phantomOf('web', 'Supplier will deliver within 48 hours.');
    const filePhantom = await phantomOf('file', 'Consultant will deliver the plan.');
    const emailPhantom = await phantomOf('email', 'Marko will prepare the export report.', false);
    // Interaction spares: the user dismissed this one (a user: audit exists).
    const dismissedPhantom = await phantomOf('web', 'Partner must submit forecasts.');
    await engine.dismiss(principal, dismissedPhantom);
    // Conclusion spares: this one is referenced by a conclusion memory.
    const concludedPhantom = await phantomOf('web', 'Vendor will confirm allocations.');
    await tdb.db.insert(taskConclusion).values({
      ownerId: owner,
      scope: 'private',
      taskId: concludedPhantom,
      conclusionType: 'closed',
      statement: 'The allocation confirmation completed the obligation.',
    });
    // Adopted after the fact: interaction is adoption — never touched.
    const adoptedPhantom = await phantomOf('web', 'Registrar must renew the domain.');
    await tdb.db.update(task).set({ adopted: true }).where(eq(task.id, adoptedPhantom));

    const report = await engine.derivationCleanup();
    expect(report.removed).toBe(3);
    expect(report.sparedByInteraction).toBe(1);
    expect(report.sparedByConclusion).toBe(1);

    const remaining = await tasksOf(engine, owner);
    const remainingIds = new Set(remaining.map((t) => t.id));
    expect(remainingIds.has(webPhantom)).toBe(false);
    expect(remainingIds.has(filePhantom)).toBe(false);
    expect(remainingIds.has(emailPhantom)).toBe(false);
    expect(remainingIds.has(dismissedPhantom)).toBe(true);
    expect(remainingIds.has(concludedPhantom)).toBe(true);
    expect(remainingIds.has(adoptedPhantom)).toBe(true);
    expect(remaining).toHaveLength(5); // 2 first-person + 3 spared/adopted

    // Deriving memories stay — only the task rows were removed.
    const memories = await tdb.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM memory WHERE owner_id = $1`,
      [owner],
    );
    expect(Number(memories.rows[0]!.n)).toBe(8);
  });

  it('migration_idempotent: a re-run removes nothing and changes nothing', async () => {
    const owner = `cleanup-idem-${randomUUID()}`;
    const engine = engineWith();
    const phantom = await insertLegacyTask(
      await seed(owner, 'web', randomUUID(), { content: 'Supplier will deliver.' }),
    );
    const first = await engine.derivationCleanup();
    expect(first.removed).toBeGreaterThanOrEqual(1);
    expect(await auditCount('task.removed', phantom)).toBe(1);

    const before = await tasksOf(engine, owner);
    const second = await engine.derivationCleanup();
    expect(second.removed).toBe(0);
    expect(await tasksOf(engine, owner)).toEqual(before);
    expect(await auditCount('task.removed', phantom)).toBe(1); // no new audit
  });

  it('migration_audited: every removal has its audit entry with the migration reason', async () => {
    const owner = `cleanup-audit-${randomUUID()}`;
    const engine = engineWith();
    const memory = await seed(owner, 'file', randomUUID(), {
      content: 'The counterparty must pay within 15 days.',
    });
    const phantom = await insertLegacyTask(memory);
    await engine.derivationCleanup();

    const { rows } = await tdb.pool.query<{ actor: string; detail_json: unknown }>(
      `SELECT actor, detail_json FROM audit_log WHERE action = 'task.removed' AND entity_id = $1`,
      [phantom],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe('tasks_engine');
    expect(rows[0]!.detail_json).toMatchObject({
      cause: 'derivation_rule_migration',
      memoryId: memory.id,
      sourceType: 'file',
    });
    // The run's summary entry exists too.
    const summary = await tdb.pool.query(
      `SELECT 1 FROM audit_log WHERE action = 'task.derivation_cleanup' LIMIT 1`,
    );
    expect(summary.rows).toHaveLength(1);
  });

  it('derivation_trap_eval: the golden-trap checker applies the real predicate', () => {
    const result = runDerivationTrapEval([
      // Web obligations: zero tasks whatever the extractor kinds them.
      {
        caseId: 'web-trap',
        lang: 'en',
        sourceType: 'web',
        authoredByUser: null,
        expectedTasks: 0,
        factKinds: ['commitment', 'open_loop', 'fact'],
      },
      // The user's own reply: exactly one.
      {
        caseId: 'email-trap',
        lang: 'en',
        sourceType: 'email',
        authoredByUser: true,
        expectedTasks: 1,
        factKinds: ['commitment'],
      },
      // A regression: an inbound email deriving would fail the trap.
      {
        caseId: 'email-inbound-trap',
        lang: 'en',
        sourceType: 'email',
        authoredByUser: false,
        expectedTasks: 0,
        factKinds: ['commitment'],
      },
    ]);
    expect(result.cases).toBe(3);
    expect(result.failures).toEqual([]);
    // And a broken expectation is reported, not swallowed.
    const broken = runDerivationTrapEval([
      {
        caseId: 'web-breaks',
        lang: 'en',
        sourceType: 'web',
        authoredByUser: null,
        expectedTasks: 2,
        factKinds: ['commitment'],
      },
    ]);
    expect(broken.failures).toHaveLength(1);
    expect(broken.failures[0]).toContain('web-breaks');
  });
});
