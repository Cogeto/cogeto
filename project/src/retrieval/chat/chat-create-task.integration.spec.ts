import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import type { ChatStreamEvent, Principal } from '@cogeto/shared';
import { fakeEmbedding, startTestDatabase, startTestQdrant } from '../../testing/index';
import type { TestDatabase, TestQdrant } from '../../testing/index';
import { createMemoryReconciliation } from '../../memory/index';
import type { MemoryStore } from '../../memory/index';
import { createIngestionPipeline } from '../../ingestion/index';
import type { IngestionPipeline } from '../../ingestion/index';
import { TasksEngine } from '../../tasks/index';
import { UserDirectory } from '../../identity/index';
import { ModelGateway, ModelGatewayError } from '../../model-gateway/index';
import type { StructuredExtractionRequest } from '../../model-gateway/index';
import { RetrievalService } from '../retrieval.service';
import { ChatService } from './chat.service';
import { ChatSourceReader } from './chat.source-reader';

const DIMS = 8;
const EMBED = 'test-embed';

/**
 * Create-a-task from chat (decision 0038): the intent is deterministic; the
 * capture routes through the REAL pipeline + task engine. The gateway is
 * scripted at the seam — extraction echoes the capture content as one
 * commitment, the rewriter echoes its input (so unresolved references STAY
 * unresolved and the ambiguity path is exercised honestly).
 */
class ScriptedGateway extends ModelGateway {
  constructor(
    private readonly entities: string[] = ['Ana'],
    private readonly subjectEntity: string | null = 'Ana',
  ) {
    super();
  }
  complete(): never {
    throw new Error('unused');
  }
  // eslint-disable-next-line require-yield -- the create-task path never streams
  async *completeStream(): AsyncIterable<string> {
    throw new Error('unused');
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => fakeEmbedding(t, DIMS));
  }
  embeddingModelId(): string {
    return EMBED;
  }
  async extractStructured<T>(schema: ZodType<T>, request: StructuredExtractionRequest): Promise<T> {
    const isRewrite = request.input.startsWith('RECENT TURNS:');
    const isVerify = request.input.startsWith('CLAIM UNDER REVIEW');
    const isReconcile = request.input.startsWith('FACT A:');
    const raw = isRewrite
      ? {
          // Echo the question unresolved — the conservative rewriter fallback.
          rewritten_query: request.input.split('QUESTION:\n')[1] ?? '',
          entities: [],
          temporal: null,
          open_loops: null,
        }
      : isReconcile
        ? request.system.includes('same_fact')
          ? { verdict: 'distinct', reason: 'scripted', merged_content: null }
          : { verdict: 'compatible', direction: null, reason: 'scripted' }
        : isVerify
          ? { verdict: 'supported', reason: 'scripted' }
          : {
              facts: [
                (() => {
                  const content = request.input.split('SOURCE CONTENT:\n')[1] ?? request.input;
                  return {
                    claim: content,
                    kind: 'commitment',
                    entities: { people: this.entities, organizations: [], projects: [] },
                    subject_entity: this.subjectEntity,
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

const principalFor = (userId: string): Principal => ({
  userId,
  name: `name-${userId}`,
  email: null,
  orgId: `org-${userId}`,
  orgName: `org-${userId}`,
  roles: [],
});

describe('create a task from chat (decision 0038; real Postgres + Qdrant)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;
  let reconciliation: Awaited<ReturnType<typeof createMemoryReconciliation>>['reconciliation'];

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

  const harness = (gateway: ScriptedGateway) => {
    const tasksEngine = new TasksEngine(tdb.db, store, gateway);
    const retrieval = new RetrievalService(store, gateway, tasksEngine);
    const chat = new ChatService(tdb.db, retrieval, gateway, new UserDirectory(tdb.db));
    const pipeline: IngestionPipeline = createIngestionPipeline({
      readers: [new ChatSourceReader(tdb.db)],
      gateway,
      store,
      reconciliation,
    });
    return { tasksEngine, chat, pipeline };
  };

  const ask = async (chat: ChatService, principal: Principal, content: string) => {
    let answer = '';
    for await (const event of chat.ask(principal, content) as AsyncIterable<ChatStreamEvent>) {
      if (event.type === 'done') answer = event.content;
    }
    return answer;
  };

  const capturedMessages = (owner: string) =>
    tdb.pool.query<{ id: string; capture_content: string | null; content: string }>(
      `SELECT id, capture_content, content FROM chat_message
       WHERE owner_id = $1 AND role = 'user' ORDER BY created_at`,
      [owner],
    );

  /** Stands in for the worker: run the enqueued capture through the real
   * stages, then the task engine — the tasks.derive job's work. */
  const processCapture = async (
    h: ReturnType<typeof harness>,
    messageId: string,
  ): Promise<void> => {
    await tdb.db.transaction((tx) =>
      h.pipeline.run(tx, { source_type: 'chat', source_id: messageId }),
    );
    await tdb.db.transaction((tx) => h.tasksEngine.processSource(tx, 'chat', messageId));
  };

  it('chat_create_task_basic: a clear request creates exactly one task via the derivation engine', async () => {
    const owner = `create-basic-${randomUUID()}`;
    const principal = principalFor(owner);
    const h = harness(new ScriptedGateway(['Baltic Retail'], 'Baltic Retail'));

    const answer = await ask(h.chat, principal, 'Make a task to chase the Baltic Retail contract');
    expect(answer).toContain('task');
    expect(answer).toContain('chase the Baltic Retail contract');

    const { rows } = await capturedMessages(owner);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.capture_content).toBe('Task: chase the Baltic Retail contract');
    // The raw message is untouched — capture_content is the extraction input.
    expect(rows[0]!.content).toBe('Make a task to chase the Baltic Retail contract');
    // Enqueued transactionally via the outbox (§A.3).
    const outbox = await tdb.pool.query(
      `SELECT 1 FROM outbox_event WHERE event_type = 'chat.task_requested'
        AND payload->>'source_id' = $1`,
      [rows[0]!.id],
    );
    expect(outbox.rows).toHaveLength(1);

    await processCapture(h, rows[0]!.id);
    const tasks = await h.tasksEngine.listForPrincipal(principal, { includeSettled: true });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toContain('chase the Baltic Retail contract');
    expect(tasks[0]!.primaryPerson).toBe('Baltic Retail');
    expect(tasks[0]!.status).toBe('open');
  });

  it('chat_create_task_with_condition: a stated condition populates condition_text and blocks the task', async () => {
    const owner = `create-cond-${randomUUID()}`;
    const principal = principalFor(owner);
    const h = harness(new ScriptedGateway(['Ana'], 'Ana'));

    const answer = await ask(
      h.chat,
      principal,
      'Make a task to send Ana the revised mapping once she confirms the format',
    );
    expect(answer).toContain('once she confirms the format'); // confirmed with the condition

    const { rows } = await capturedMessages(owner);
    await processCapture(h, rows[0]!.id);
    const tasks = await h.tasksEngine.listForPrincipal(principal, { includeSettled: true });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe('blocked_on_condition');
    expect(tasks[0]!.conditionText).toContain('once she confirms the format');
    expect(tasks[0]!.conditionMet).toBe(false);
  });

  it('chat_create_task_hr_condition: a hr "čim" condition blocks the task (the ASCII \\b regression)', async () => {
    const owner = `create-hr-${randomUUID()}`;
    const principal = principalFor(owner);
    const h = harness(new ScriptedGateway(['Ana'], 'Ana'));

    const answer = await ask(
      h.chat,
      principal,
      'Napravi zadatak da pošaljem Ani revidirano mapiranje čim potvrdi format',
    );
    expect(answer).toContain('Zabilježeno kao zadatak');
    expect(answer).toContain('čim potvrdi format'); // the condition made the confirmation

    const { rows } = await capturedMessages(owner);
    expect(rows[0]!.capture_content).toBe(
      'Zadatak: pošaljem Ani revidirano mapiranje čim potvrdi format',
    );
    await processCapture(h, rows[0]!.id);
    const tasks = await h.tasksEngine.listForPrincipal(principal, { includeSettled: true });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe('blocked_on_condition');
    expect(tasks[0]!.conditionText).toContain('čim potvrdi format');
  });

  it('chat_create_task_ambiguous: an unresolvable reference asks a clarifying question and creates nothing', async () => {
    const owner = `create-ambig-${randomUUID()}`;
    const principal = principalFor(owner);
    const h = harness(new ScriptedGateway());

    const answer = await ask(h.chat, principal, 'Make a task to send her the revised mapping');
    expect(answer).toContain("can't tell who or what");

    const { rows } = await capturedMessages(owner);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.capture_content).toBeNull(); // nothing captured
    const outbox = await tdb.pool.query(
      `SELECT 1 FROM outbox_event WHERE event_type = 'chat.task_requested'
        AND payload->>'source_id' = $1`,
      [rows[0]!.id],
    );
    expect(outbox.rows).toHaveLength(0); // nothing enqueued
    expect(await h.tasksEngine.listForPrincipal(principal, { includeSettled: true })).toHaveLength(
      0,
    );
  });

  it('chat_create_task_none: a bare trigger with nothing actionable creates nothing and says so', async () => {
    const owner = `create-none-${randomUUID()}`;
    const principal = principalFor(owner);
    const h = harness(new ScriptedGateway());

    const answer = await ask(h.chat, principal, 'Add a task');
    expect(answer.toLowerCase()).toContain('anything actionable');

    const { rows } = await capturedMessages(owner);
    expect(rows[0]!.capture_content).toBeNull();
    expect(await h.tasksEngine.listForPrincipal(principal, { includeSettled: true })).toHaveLength(
      0,
    );

    // A question ABOUT tasks never fires the intent at all (the veto): it
    // falls through to normal retrieval and captures nothing.
    const answer2 = await ask(h.chat, principal, 'Did I make a task for Marko?');
    expect(answer2).not.toContain('captured that as a task');
    const after = await capturedMessages(owner);
    expect(after.rows.every((r) => r.capture_content === null)).toBe(true);
  });

  it('chat_create_task_provenance: the deriving memory is the chat commitment with source_type chat', async () => {
    const owner = `create-prov-${randomUUID()}`;
    const principal = principalFor(owner);
    const h = harness(new ScriptedGateway(['Ana'], 'Ana'));

    await ask(h.chat, principal, 'Remind me to follow up with Ana next week');
    const { rows } = await capturedMessages(owner);
    expect(rows[0]!.capture_content).toBe('Task: follow up with Ana next week');
    await processCapture(h, rows[0]!.id);

    const tasks = await h.tasksEngine.listForPrincipal(principal, { includeSettled: true });
    expect(tasks).toHaveLength(1);
    const memory = await tdb.pool.query<{ source_type: string; source_id: string; kind: string }>(
      `SELECT source_type, source_id, kind FROM memory WHERE id = $1`,
      [tasks[0]!.derivedFromMemoryId],
    );
    expect(memory.rows[0]!.source_type).toBe('chat');
    expect(memory.rows[0]!.source_id).toBe(rows[0]!.id);
    expect(memory.rows[0]!.kind).toBe('commitment');
  });
});
