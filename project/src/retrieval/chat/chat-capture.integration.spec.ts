import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
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
import { ChatSourceDeletion } from './chat.source-deletion';
import { chatMessage } from '../persistence/tables';

const DIMS = 8;
const EMBED = 'test-embed';

/** The gateway mocked at the seam: extract one scripted fact, verify supported. */
class ScriptedGateway extends ModelGateway {
  constructor(private readonly kind: string = 'commitment') {
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
    return texts.map((t) => fakeEmbedding(t, DIMS));
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
        : { verdict: 'compatible', direction: null, reason: 'scripted' }
      : isVerify
        ? { verdict: 'supported', reason: 'scripted' }
        : {
            facts: [
              {
                claim: request.input,
                kind: this.kind,
                entities: { people: ['Marko'], organizations: [], projects: [] },
                condition: null,
                temporal: { valid_from: null, valid_until: null, anchors_resolved: true },
                source_span: request.input.slice(0, 40),
              },
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

describe('chat capture (integration, real Postgres + Qdrant)', () => {
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

  const pipelineWith = (gateway: ScriptedGateway): IngestionPipeline =>
    createIngestionPipeline({
      readers: [new ChatSourceReader(tdb.db)],
      gateway,
      store,
      reconciliation,
    });

  const seedMessage = async (
    owner: string,
    role: 'user' | 'assistant',
    content: string,
  ): Promise<string> => {
    const [row] = await tdb.db
      .insert(chatMessage)
      .values({ ownerId: owner, role, content })
      .returning();
    return row!.id;
  };
  const memoriesForChat = (id: string) =>
    tdb.pool.query<{ content: string; status: string; scope: string; kind: string | null }>(
      `SELECT content, status, scope, kind FROM memory WHERE source_type = 'chat' AND source_id = $1`,
      [id],
    );
  const runPipeline = (pipeline: IngestionPipeline, id: string) =>
    tdb.db.transaction((tx) => pipeline.run(tx, { source_type: 'chat', source_id: id }));

  it('chat_source_reader_loads_user_messages_only: the assistant is never a source', async () => {
    const owner = `chat-reader-${randomUUID()}`;
    const reader = new ChatSourceReader(tdb.db);
    const userId = await seedMessage(owner, 'user', 'I will send Marko the contract on Monday.');
    const assistantId = await seedMessage(owner, 'assistant', 'Noted — I will remember that.');

    const item = await reader.load(userId);
    expect(item?.sourceType).toBe('chat');
    expect(item?.ownerId).toBe(owner);
    expect(item?.content).toContain('contract');
    // The assistant's own reply can never become a source item (decision 0021 r4).
    expect(await reader.load(assistantId)).toBeNull();
  });

  it('chat_capture_creates_memory_with_chat_provenance: a stated fact becomes a private chat memory', async () => {
    const owner = `chat-fact-${randomUUID()}`;
    const id = await seedMessage(owner, 'user', 'We chose Postgres for the Atlas project.');
    const summary = await runPipeline(pipelineWith(new ScriptedGateway('decision')), id);
    expect(summary.admitted.active).toBeGreaterThanOrEqual(1);

    const { rows } = await memoriesForChat(id);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.status).toBe('active');
    expect(rows[0]!.scope).toBe('private'); // chat capture defaults private (ruling 6)
  });

  it('chat_commitment_derives_a_task: a commitment stated in chat derives a task like a note', async () => {
    const owner = `chat-task-${randomUUID()}`;
    const principal = principalFor(owner);
    const id = await seedMessage(owner, 'user', 'I will send Marko the signed contract.');
    await runPipeline(pipelineWith(new ScriptedGateway('commitment')), id);

    // The task engine derives from the chat-sourced memory exactly as for a note.
    const engine = new TasksEngine(tdb.db, store, new ScriptedGateway());
    const report = await tdb.db.transaction((tx) => engine.processSource(tx, 'chat', id));
    expect(report.derived).toBe(1);
    const tasks = await engine.listForPrincipal(principal);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toContain('contract');
  });

  it('remember_refuses_assistant_and_foreign, captures own: the audited affordance gates role + owner', async () => {
    const owner = `chat-remember-${randomUUID()}`;
    const principal = principalFor(owner);
    const chat = new ChatService(
      tdb.db,
      new RetrievalService(store, new ScriptedGateway()),
      new ScriptedGateway(),
      new UserDirectory(tdb.db),
    );
    const assistantId = await seedMessage(owner, 'assistant', 'Here is your answer.');
    const foreignId = await seedMessage(`other-${randomUUID()}`, 'user', 'Someone else’s message.');
    const mineId = await seedMessage(owner, 'user', 'Remember I prefer async standups.');

    await expect(chat.rememberMessage(principal, assistantId)).rejects.toThrow(/never captured/i);
    await expect(chat.rememberMessage(principal, foreignId)).rejects.toThrow(/not found/i);

    const result = await chat.rememberMessage(principal, mineId);
    expect(result.messageId).toBe(mineId);
    // It enqueued transactionally via the outbox (§A.3) for the chat source.
    const { rows } = await tdb.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbox_event
       WHERE event_type = 'chat.remembered' AND payload->>'source_id' = $1`,
      [mineId],
    );
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(1);
  });

  it('chat_source_deletion_removes_the_message: the saga port erases the originating turn', async () => {
    const owner = `chat-del-${randomUUID()}`;
    const id = await seedMessage(owner, 'user', 'A message to be forgotten.');
    const deletion = new ChatSourceDeletion();
    await tdb.db.transaction(async (tx) => {
      expect(await deletion.ownerOf(tx, id)).toBe(owner);
      await deletion.deleteSource(tx, id);
    });
    const { rows } = await tdb.pool.query(`SELECT 1 FROM chat_message WHERE id = $1`, [id]);
    expect(rows).toHaveLength(0);
  });
});
