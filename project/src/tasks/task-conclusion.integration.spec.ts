import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import { startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { createMemoryReconciliation } from '../memory/index';
import type { MemoryReconciliation, MemoryRow, MemoryStore, NewFact } from '../memory/index';
import { createIngestionPipeline } from '../ingestion/index';
import type { IngestionPipeline } from '../ingestion/index';
import { ModelGateway, ModelGatewayError } from '../model-gateway/index';
import type { StructuredExtractionRequest } from '../model-gateway/index';
import { TasksEngine } from './tasks.engine';
import { TaskConclusionSourceReader } from './task-conclusion.source-ports';

const DIMS = 8;
const EMBED = 'test-embed';
/** Controlled vectors (mirror of the reconcile spec): 0.85 normalized cosine —
 * inside the contradiction band [0.80, 0.93). */
const BASE_VEC = [1, 0, 0, 0, 0, 0, 0, 0];
const MID_BAND_VEC = [0.7, Math.sqrt(1 - 0.49), 0, 0, 0, 0, 0, 0];

const principalFor = (userId: string): Principal => ({
  userId,
  name: 'Conclusion Tester',
  email: null,
  orgId: 'org-conclusions',
  orgName: 'org-conclusions',
  roles: [],
});

/** Task-judgment gateway: closure/condition verdicts scripted at the seam. */
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
    return EMBED;
  }
  async extractStructured<T>(schema: ZodType<T>, request: StructuredExtractionRequest): Promise<T> {
    const raw = request.system.includes('FULFILLED') ? this.closure() : this.condition();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelGatewayError('scripted output failed schema', false);
    return parsed.data;
  }
}

/** Pipeline gateway: extraction/verification/reconciliation scripted so the
 * conclusion statement flows through the REAL stages deterministically. */
class ScriptedPipelineGateway extends ModelGateway {
  constructor(
    private readonly fact: { kind: string; subjectEntity?: string | null; people?: string[] },
    private readonly contradiction: () => {
      verdict: string;
      direction?: string | null;
      reason: string;
    } = () => ({ verdict: 'compatible', direction: null, reason: 'scripted' }),
    private readonly vector: number[] = MID_BAND_VEC,
  ) {
    super();
  }
  complete(): never {
    throw new Error('unused');
  }
  // eslint-disable-next-line require-yield -- unused
  async *completeStream(): AsyncIterable<string> {
    throw new Error('unused');
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => this.vector);
  }
  embeddingModelId(): string {
    return EMBED;
  }
  async extractStructured<T>(schema: ZodType<T>, request: StructuredExtractionRequest): Promise<T> {
    const isVerify = request.input.startsWith('CLAIM UNDER REVIEW');
    const isReconcile = request.input.startsWith('FACT A:');
    const raw = isReconcile
      ? request.system.includes('same_fact')
        ? { verdict: 'distinct', reason: 'scripted', merged_content: null }
        : this.contradiction()
      : isVerify
        ? { verdict: 'supported', reason: 'scripted' }
        : {
            facts: [
              (() => {
                const content = request.input.split('SOURCE CONTENT:\n')[1] ?? request.input;
                return {
                  claim: content,
                  kind: this.fact.kind,
                  entities: {
                    people: this.fact.people ?? ['Marko'],
                    organizations: [],
                    projects: [],
                  },
                  subject_entity: this.fact.subjectEntity ?? null,
                  condition: null,
                  temporal: { valid_from: null, valid_until: null, anchors_resolved: true },
                  source_span: content.slice(0, 40),
                };
              })(),
            ],
          };
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelGatewayError('scripted output failed schema', false);
    return parsed.data;
  }
}

describe('task conclusions become memories (decision 0037; real Postgres + Qdrant)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;
  let reconciliation: MemoryReconciliation;

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    ({ store, reconciliation } = createMemoryReconciliation({
      db: tdb.db,
      qdrant: { url: qdrant.url, embeddingModel: EMBED, dimensions: DIMS },
    }));
    await store.ensureIndexReady();
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  const engineWith = (gateway: ScriptedJudgeGateway) => new TasksEngine(tdb.db, store, gateway);
  const seed = (
    owner: string,
    sourceId: string,
    fact: Partial<NewFact> & { content: string },
  ): Promise<MemoryRow> =>
    store.createFromFact(principalFor(owner), {
      scope: 'private',
      sourceType: 'user_note',
      sourceId,
      entities: [],
      embeddingModel: EMBED,
      ...fact,
    } as NewFact);
  const run = (engine: TasksEngine, sourceId: string) =>
    tdb.db.transaction((tx) => engine.processSource(tx, 'user_note', sourceId));
  const conclusionsFor = (taskId: string) =>
    tdb.pool.query<{
      id: string;
      conclusion_type: string;
      statement: string;
      scope: string;
      sensitive: boolean;
      deriving_memory_id: string | null;
      trigger_memory_id: string | null;
    }>(`SELECT * FROM task_conclusion WHERE task_id = $1 ORDER BY created_at`, [taskId]);
  const pipelineFor = (gateway: ScriptedPipelineGateway): IngestionPipeline =>
    createIngestionPipeline({
      readers: [new TaskConclusionSourceReader(tdb.db)],
      gateway,
      store,
      reconciliation,
    });
  const runPipeline = (pipeline: IngestionPipeline, conclusionId: string) =>
    tdb.db.transaction((tx) =>
      pipeline.run(tx, { source_type: 'task_conclusion', source_id: conclusionId }),
    );
  const conclusionMemories = (conclusionId: string) =>
    tdb.pool.query<{ id: string; content: string; status: string; kind: string | null }>(
      `SELECT id, content, status, kind FROM memory
       WHERE source_type = 'task_conclusion' AND source_id = $1`,
      [conclusionId],
    );

  /** Derives a task from a commitment and closes it with a scripted verdict. */
  const deriveAndClose = async (
    owner: string,
    commitment: Partial<NewFact> & { content: string },
    closing: Partial<NewFact> & { content: string },
  ) => {
    const gateway = new ScriptedJudgeGateway(() => ({ verdict: 'closes', reason: 'scripted' }));
    const engine = engineWith(gateway);
    const commitmentSource = randomUUID();
    const deriving = await seed(owner, commitmentSource, { kind: 'commitment', ...commitment });
    await run(engine, commitmentSource);
    const closingSource = randomUUID();
    const trigger = await seed(owner, closingSource, { kind: 'fact', ...closing });
    const report = await run(engine, closingSource);
    const [task] = await engine.listForPrincipal(principalFor(owner), { includeSettled: true });
    return { engine, deriving, trigger, report, task: task!, closingSource };
  };

  it('conclusion_on_closure: closing a task derives exactly one conclusion memory with the full provenance chain, entered via the pipeline', async () => {
    const owner = `concl-close-${randomUUID()}`;
    const { deriving, trigger, report, task } = await deriveAndClose(
      owner,
      {
        content: 'You will send Marko the revised proposal.',
        entities: ['Marko'],
        subjectEntity: 'Marko',
        validFrom: new Date('2026-07-02T00:00:00Z'),
      },
      {
        content: 'The revised proposal was sent to Marko.',
        entities: ['Marko'],
        subjectEntity: 'Marko',
        validFrom: new Date('2026-07-14T00:00:00Z'),
      },
    );
    expect(report.closed).toBe(1);
    expect(task.status).toBe('done');

    const { rows } = await conclusionsFor(task.id);
    expect(rows).toHaveLength(1);
    const conclusion = rows[0]!;
    expect(conclusion.conclusion_type).toBe('closed');
    // The inspectable chain (decision 0037 ruling 2): BOTH the deriving memory
    // and the closing source are referenced.
    expect(conclusion.deriving_memory_id).toBe(deriving.id);
    expect(conclusion.trigger_memory_id).toBe(trigger.id);
    // Deterministic phrasing carries the trigger, the commitment and both dates.
    expect(conclusion.statement).toContain('The revised proposal was sent to Marko');
    expect(conclusion.statement).toContain('completed the commitment');
    expect(conclusion.statement).toContain('2 July 2026');
    expect(conclusion.statement).toContain('14 July 2026');

    // The capture was enqueued transactionally through the outbox (§A.3).
    const outbox = await tdb.pool.query(
      `SELECT 1 FROM outbox_event WHERE event_type = 'task.concluded'
        AND payload->>'source_id' = $1`,
      [conclusion.id],
    );
    expect(outbox.rows).toHaveLength(1);

    // The worker's pipeline run admits the memory with 'task_conclusion'
    // provenance — the ONE sanctioned path (never a raw insert).
    const summary = await runPipeline(
      pipelineFor(new ScriptedPipelineGateway({ kind: 'fact', people: ['Marko'] })),
      conclusion.id,
    );
    expect(summary.admitted.active).toBe(1);
    const memories = await conclusionMemories(conclusion.id);
    expect(memories.rows).toHaveLength(1);
    expect(memories.rows[0]!.content).toContain('completed the commitment');
    expect(memories.rows[0]!.status).toBe('active');
  });

  it('conclusion_on_condition_met: satisfying a condition derives the conclusion and flips the task open', async () => {
    const owner = `concl-cond-${randomUUID()}`;
    const gateway = new ScriptedJudgeGateway(
      () => ({ verdict: 'unrelated', reason: 'scripted' }),
      () => ({ verdict: 'satisfied', reason: 'scripted' }),
    );
    const engine = engineWith(gateway);
    const commitmentSource = randomUUID();
    const deriving = await seed(owner, commitmentSource, {
      content: 'You will send Luka the offer after Luka confirms the budget.',
      kind: 'commitment',
      entities: ['Luka'],
      subjectEntity: 'Luka',
    });
    await run(engine, commitmentSource);
    const satisfyingSource = randomUUID();
    const trigger = await seed(owner, satisfyingSource, {
      content: 'Luka confirmed the budget.',
      kind: 'fact',
      entities: ['Luka'],
      subjectEntity: 'Luka',
    });
    const report = await run(engine, satisfyingSource);
    expect(report.conditionsMet).toBe(1);

    const [task] = await engine.listForPrincipal(principalFor(owner));
    expect(task!.status).toBe('open');
    expect(task!.conditionMet).toBe(true);

    const { rows } = await conclusionsFor(task!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conclusion_type).toBe('condition_met');
    expect(rows[0]!.deriving_memory_id).toBe(deriving.id);
    expect(rows[0]!.trigger_memory_id).toBe(trigger.id);
    expect(rows[0]!.statement).toContain('Luka confirmed the budget');
    expect(rows[0]!.statement).toContain('satisfied the condition');
    expect(rows[0]!.statement).toContain('after Luka confirms the budget');
  });

  it('conclusion_idempotent: re-delivery and repeated user completes produce no duplicate conclusions', async () => {
    const owner = `concl-idem-${randomUUID()}`;
    const { engine, report, task, closingSource } = await deriveAndClose(
      owner,
      { content: 'You will send Vera the summary.', entities: ['Vera'] },
      { content: 'The summary was sent to Vera.', entities: ['Vera'] },
    );
    expect(report.closed).toBe(1);

    // Re-delivered closure source: the settled task has left the candidate
    // pool and the settle re-check no-ops under its row lock; the unique
    // (task, type, trigger) index is the belt underneath.
    const again = await run(engine, closingSource);
    expect(again.closed).toBe(0);
    expect((await conclusionsFor(task.id)).rows).toHaveLength(1);

    // A user-completed task concludes once; the second complete is the
    // documented idempotent no-op and emits nothing.
    const userOwner = `concl-idem-user-${randomUUID()}`;
    const userEngine = engineWith(new ScriptedJudgeGateway());
    const source = randomUUID();
    await seed(userOwner, source, {
      content: 'You will file the Atlas report.',
      kind: 'commitment',
      entities: ['Atlas'],
    });
    await run(userEngine, source);
    const [userTask] = await userEngine.listForPrincipal(principalFor(userOwner));
    await userEngine.complete(principalFor(userOwner), userTask!.id);
    await userEngine.complete(principalFor(userOwner), userTask!.id); // no-op
    const { rows } = await conclusionsFor(userTask!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conclusion_type).toBe('closed');
    expect(rows[0]!.trigger_memory_id).toBeNull(); // the user, not a memory
    expect(rows[0]!.statement).toContain('was completed on');
  });

  it('conclusion_scope_sensitive: the conclusion inherits the task scope; a sensitive source anywhere in the chain makes it sensitive', async () => {
    const owner = `concl-scope-${randomUUID()}`;
    const { task } = await deriveAndClose(
      owner,
      {
        content: 'You will share the Atlas summary with the org.',
        entities: ['Atlas'],
        scope: 'shared',
      },
      { content: 'The Atlas summary was shared.', entities: ['Atlas'], sensitive: true },
    );
    const { rows } = await conclusionsFor(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scope).toBe('shared'); // task scope, inherited from the deriving memory
    expect(rows[0]!.sensitive).toBe(true); // the closing source was sensitive

    // The reader carries both into the SourceItem so admission inherits them.
    const item = await new TaskConclusionSourceReader(tdb.db).load(rows[0]!.id);
    expect(item?.scope).toBe('shared');
    expect(item?.sensitive).toBe(true);
  });

  it('conclusion_is_pipeline_not_raw: no memory exists until the pipeline admits it, then it carries verification like any fact', async () => {
    const owner = `concl-pipe-${randomUUID()}`;
    const { task } = await deriveAndClose(
      owner,
      { content: 'You will send Iva the invoice.', entities: ['Iva'] },
      { content: 'The invoice went out to Iva.', entities: ['Iva'] },
    );
    const conclusion = (await conclusionsFor(task.id)).rows[0]!;

    // The engine recorded the conclusion + enqueue but wrote NO memory row —
    // the tasks module never inserts into memory (tasks_read_only_memory).
    expect((await conclusionMemories(conclusion.id)).rows).toHaveLength(0);

    const summary = await runPipeline(
      pipelineFor(new ScriptedPipelineGateway({ kind: 'fact', people: ['Iva'] })),
      conclusion.id,
    );
    expect(summary.admitted.active).toBe(1);
    const memory = (await conclusionMemories(conclusion.id)).rows[0]!;
    // Admitted through the normal §B.3 stages: the verification pass recorded
    // its verdict — raw inserts leave no verification_result.
    const verification = await tdb.pool.query(
      `SELECT verdict FROM verification_result WHERE memory_id = $1`,
      [memory.id],
    );
    expect(verification.rows).toHaveLength(1);
  });

  it('conclusion_participates: a completion fact can supersede the open commitment via existing reconciliation, and never re-derives a task', async () => {
    const owner = `concl-part-${randomUUID()}`;
    const { deriving, task } = await deriveAndClose(
      owner,
      {
        content: 'You will send Marko the revised proposal.',
        entities: ['Marko'],
        subjectEntity: 'Marko',
        validFrom: new Date('2026-07-02T00:00:00Z'),
      },
      {
        content: 'The revised proposal was sent to Marko.',
        entities: ['Marko'],
        subjectEntity: 'Marko',
        validFrom: new Date('2026-07-14T00:00:00Z'),
      },
    );
    const conclusion = (await conclusionsFor(task.id)).rows[0]!;
    // Give the standing commitment a controlled vector so the conclusion lands
    // in the contradiction band against it, then script the contradiction
    // model to rule the (temporally later) conclusion supersedes it.
    await store.upsertVectors([deriving], [BASE_VEC]);
    const summary = await runPipeline(
      pipelineFor(
        // Deliberately extracted as kind 'commitment' — the WORST case for the
        // loop guard below; contradiction candidates accept it all the same.
        new ScriptedPipelineGateway(
          { kind: 'commitment', subjectEntity: 'Marko', people: ['Marko'] },
          () => ({
            verdict: 'supersedes',
            direction: 'a_over_b',
            reason: 'the commitment was fulfilled',
          }),
        ),
      ),
      conclusion.id,
    );
    expect(summary.admitted.active).toBe(1);
    expect(summary.reconcile.superseded).toBe(1);

    const conclusionMemory = (await conclusionMemories(conclusion.id)).rows[0]!;
    const commitment = await tdb.pool.query<{ status: string; superseded_by: string | null }>(
      `SELECT status, superseded_by FROM memory WHERE id = $1`,
      [deriving.id],
    );
    // The open commitment is resolved by its own completion — §B.2 mechanics.
    expect(commitment.rows[0]!.status).toBe('replaced');
    expect(commitment.rows[0]!.superseded_by).toBe(conclusionMemory.id);

    // No loop (decision 0037 ruling 6): even if the extractor mislabeled the
    // conclusion a commitment, a 'task_conclusion' source derives NO task.
    const loopEngine = engineWith(new ScriptedJudgeGateway());
    const loopReport = await tdb.db.transaction((tx) =>
      loopEngine.processSource(tx, 'task_conclusion', conclusion.id),
    );
    expect(loopReport.derived).toBe(0);
  });
});
