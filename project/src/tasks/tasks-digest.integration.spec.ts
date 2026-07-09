import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase } from '../testing/index';
import type { TestDatabase } from '../testing/index';
import { createMemoryStore } from '../memory/index';
import type { MemoryStore, NewFact } from '../memory/index';
import { ModelGateway, ModelGatewayError } from '../model-gateway/index';
import type { StructuredExtractionRequest } from '../model-gateway/index';
import { DreamingController } from '../ingestion/index';
import type { AuthenticatedRequest } from '../identity/index';
import { TasksEngine } from './tasks.engine';
import { TasksDigestSection } from './tasks-digest';

/** Each owner gets its own org so shared-visibility gating is unambiguous. */
const principalFor = (userId: string): Principal => ({
  userId,
  name: 'Digest Tester',
  email: null,
  orgId: `org-${userId}`,
  orgName: `org-${userId}`,
  roles: [],
});

/** Closure holds (never 'closes') so the satisfying fact unblocks, not closes. */
class UnblockGateway extends ModelGateway {
  complete(): never {
    throw new Error('not used');
  }
  // eslint-disable-next-line require-yield -- not used
  async *completeStream(): AsyncIterable<string> {
    throw new Error('not used');
  }
  async embed(): Promise<number[][]> {
    throw new Error('not used');
  }
  embeddingModelId(): string {
    return 'test-embed';
  }
  async extractStructured<T>(schema: ZodType<T>, request: StructuredExtractionRequest): Promise<T> {
    const raw = request.system.includes('FULFILLED')
      ? { verdict: 'unrelated', reason: 'scripted' }
      : { verdict: 'satisfied', reason: 'scripted' };
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelGatewayError('scripted output failed schema', false);
    return parsed.data;
  }
}

describe('digest composition (integration, real Postgres)', () => {
  let tdb: TestDatabase;
  let store: MemoryStore;

  beforeAll(async () => {
    tdb = await startTestDatabase();
    store = createMemoryStore({ db: tdb.db });
  });
  afterAll(async () => {
    await tdb.stop();
  });

  const engine = () => new TasksEngine(tdb.db, store, new UnblockGateway());
  const controller = () =>
    new DreamingController(tdb.db, store, new TasksDigestSection(tdb.db, store));
  const seed = (owner: string, sourceId: string, fact: Partial<NewFact> & { content: string }) =>
    store.createFromFact(principalFor(owner), {
      scope: 'private',
      sourceType: 'user_note',
      sourceId,
      entities: [],
      ...fact,
    } as NewFact);
  const derive = (owner: string, sourceId: string) =>
    tdb.db.transaction((tx) => engine().processSource(tx, 'user_note', sourceId));
  const seedFinishedRun = async (
    actions: { pass: string; memoryId: string }[],
  ): Promise<string> => {
    const { rows } = await tdb.pool.query<{ id: string }>(
      `INSERT INTO dream_run (started_at, finished_at, scope_from, scope_to)
       VALUES (now() - interval '1 hour', now(), now() - interval '1 hour', now())
       RETURNING id`,
    );
    const runId = rows[0]!.id;
    for (const a of actions) {
      await tdb.pool.query(
        `INSERT INTO dream_action (run_id, pass, memory_id) VALUES ($1, $2, $3)`,
        [runId, a.pass, a.memoryId],
      );
    }
    return runId;
  };
  const setDue = (taskId: string, due: Date) =>
    tdb.pool.query(`UPDATE task SET due = $2 WHERE id = $1`, [taskId, due]);
  const setDormant = (taskId: string) =>
    tdb.pool.query(`UPDATE task SET dormant = true WHERE id = $1`, [taskId]);

  it('digest_composition: dreaming section first, then tasks (due → unblocked → dormant), capped', async () => {
    const owner = `digest-compose-${randomUUID()}`;
    const principal = principalFor(owner);

    // ── Consolidation section: a contradiction + a staleness action ──────────
    const conflicted = await seed(owner, randomUUID(), {
      content: 'Go-live is October 1.',
      kind: 'decision',
      subjectEntity: 'Atlas',
    });
    const stale = await seed(owner, randomUUID(), {
      content: 'Contractor access expired.',
      kind: 'fact',
      subjectEntity: 'Access',
    });
    const runId = await seedFinishedRun([
      { pass: 'contradiction', memoryId: conflicted.id },
      { pass: 'staleness', memoryId: stale.id },
    ]);

    // ── Tasks section: an overdue task, a newly-unblocked task, a dormant one ─
    const sOverdue = randomUUID();
    await seed(owner, sOverdue, { content: 'You will submit the report.', kind: 'commitment' });
    await derive(owner, sOverdue);
    const overdue = (await engine().listForPrincipal(principal)).find((t) =>
      t.title.includes('report'),
    )!;
    await setDue(overdue.id, new Date(Date.now() - 2 * 24 * 3600 * 1000));

    const sBlocked = randomUUID();
    await seed(owner, sBlocked, {
      content: 'Send Ivo the offer after Ivo signs the NDA.',
      kind: 'commitment',
      entities: ['Ivo'],
    });
    await derive(owner, sBlocked);
    const sUnblock = randomUUID();
    await seed(owner, sUnblock, {
      content: 'Ivo signed the NDA this morning.',
      kind: 'fact',
      entities: ['Ivo'],
    });
    const report = await derive(owner, sUnblock);
    expect(report.conditionsMet).toBe(1); // the blocked task is now open

    const sDormant = randomUUID();
    await seed(owner, sDormant, { content: 'You will prepare the recap.', kind: 'commitment' });
    await derive(owner, sDormant);
    const dormant = (await engine().listForPrincipal(principal)).find((t) =>
      t.title.includes('recap'),
    )!;
    await setDormant(dormant.id);

    // The reminders pass stamps the due + dormant tasks (idempotent).
    await engine().runReminders();

    const digest = await controller().latest({ principal } as AuthenticatedRequest);
    expect(digest.runId).toBe(runId);

    const consolidation = digest.lines.filter((l) => l.section !== 'tasks');
    const tasks = digest.lines.filter((l) => l.section === 'tasks');
    // Dreaming lines come first; tasks lines follow (F3 §3 ordering).
    const lastConsolidation = digest.lines.map((l) => l.section).lastIndexOf('consolidation');
    const firstTask = digest.lines.findIndex((l) => l.section === 'tasks');
    expect(lastConsolidation).toBeLessThan(firstTask);

    // Consolidation: the two actions produced their line shapes.
    expect(consolidation.some((l) => l.href === '/review?tab=contradicted')).toBe(true);
    expect(consolidation.some((l) => l.href === '/memories?status=outdated')).toBe(true);
    expect(consolidation.length).toBeLessThanOrEqual(6);

    // Tasks: capped at 3, ordered due → unblocked → dormant, all → /tasks.
    expect(tasks.length).toBeLessThanOrEqual(3);
    expect(tasks.every((l) => l.href === '/tasks')).toBe(true);
    expect(tasks[0]!.text).toMatch(/Overdue by 2 days/);
    expect(tasks.some((l) => /Now unblocked/.test(l.text))).toBe(true);
    expect(tasks.some((l) => /Gone quiet/.test(l.text))).toBe(true);
    // due comes before unblocked comes before dormant.
    const idx = (re: RegExp) => tasks.findIndex((l) => re.test(l.text));
    expect(idx(/Overdue/)).toBeLessThan(idx(/Now unblocked/));
    expect(idx(/Now unblocked/)).toBeLessThan(idx(/Gone quiet/));
  });

  it('digest_silent_when_empty: an empty run and an empty task set render no lines', async () => {
    // A stranger (own org) sees neither the seeded run's memories nor any task.
    const stranger = principalFor(`digest-stranger-${randomUUID()}`);
    const digest = await controller().latest({ principal: stranger } as AuthenticatedRequest);
    expect(digest.lines).toEqual([]);
  });
});
