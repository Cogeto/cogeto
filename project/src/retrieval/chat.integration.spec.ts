import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@cogeto/shared';
import { fakeEmbedding, startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { createMemoryStore } from '../memory/index';
import type { MemoryStore, NewFact } from '../memory/index';
import { ModelGateway } from '../model-gateway/index';
import type { CompletionRequest } from '../model-gateway/index';
import { ChatService } from './chat/chat.service';
import { NOTHING_ON_RECORD } from './chat/answer-prompt';
import { RetrievalService } from './retrieval.service';
import { chatMessage } from './persistence/tables';

/**
 * chat_grounding / chat_fast_path: the S3-A named tests. Real Postgres + real
 * Qdrant; the gateway mocked at the seam for determinism.
 */

const DIMS = 8;
const MODEL = 'test-embed';

const userA: Principal = {
  userId: 'user-a',
  name: 'User A',
  email: null,
  orgId: 'org-1',
  orgName: 'Org',
  roles: [],
};
const userB: Principal = { ...userA, userId: 'user-b', name: 'User B' };
const userEmpty: Principal = { ...userA, userId: 'user-empty', name: 'Empty' };

/** Streams a scripted answer citing [F1]; records every request it saw. */
class ScriptedChatGateway extends ModelGateway {
  streamRequests: CompletionRequest[] = [];
  embedCalls = 0;

  complete(): never {
    throw new Error('not used by chat');
  }
  extractStructured<T>(): Promise<T> {
    throw new Error('not used by chat');
  }
  async embed(texts: string[]): Promise<number[][]> {
    this.embedCalls += texts.length;
    return texts.map((text) => fakeEmbedding(text, DIMS));
  }
  embeddingModelId(): string {
    return MODEL;
  }
  async *completeStream(request: CompletionRequest): AsyncIterable<string> {
    this.streamRequests.push(request);
    yield 'You owe Maja the draft contract before Thursday ';
    yield '[F1]';
    yield '.';
  }
}

describe('chat (integration, real Postgres + real Qdrant, gateway mocked)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;
  let chat: ChatService;
  const gateway = new ScriptedChatGateway();

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    store = createMemoryStore({
      db: tdb.db,
      qdrant: { url: qdrant.url, embeddingModel: MODEL, dimensions: DIMS },
    });
    await store.ensureIndexReady();
    chat = new ChatService(tdb.db, new RetrievalService(store, gateway), gateway);
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  const seed = async (principal: Principal, newFact: NewFact) => {
    const row = await store.createFromFact(principal, {
      embeddingModel: MODEL,
      ...newFact,
    });
    await store.upsertVectors([row], [fakeEmbedding(row.content as string, DIMS)]);
    return row;
  };

  const collect = async (principal: Principal, question: string) => {
    const events = [];
    for await (const event of chat.ask(principal, question)) events.push(event);
    return events;
  };

  it('chat_grounding: the answer context contains only retrieved facts; citations persist as stable markers', async () => {
    const aFact = await seed(userA, {
      content: 'Maja needs the draft contract before Thursday',
      scope: 'private',
      sourceType: 'user_note',
      sourceId: 'note-a1',
      entities: ['Maja'],
    });
    await seed(userA, {
      content: 'The Arkona kickoff moved to July 20',
      scope: 'private',
      sourceType: 'user_note',
      sourceId: 'note-a2',
      entities: ['Arkona'],
    });
    const bSecret = await seed(userB, {
      content: 'Vault code for the Meridian archive is 4-1-7-7',
      scope: 'private',
      sourceType: 'user_note',
      sourceId: 'note-b1',
      entities: ['Meridian'],
    });

    const question = 'What do I owe Maja?';
    const events = await collect(userA, question);

    const sources = events.find((e) => e.type === 'sources');
    expect(sources?.type).toBe('sources');
    const facts = sources!.type === 'sources' ? sources!.facts : [];
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.map((f) => f.memoryId)).toContain(aFact.id);
    // Ungated content can never enter the context — B's memory is absent.
    expect(facts.map((f) => f.memoryId)).not.toContain(bSecret.id);
    // Per-result contract: status, sensitive, source ref, signals that hit.
    const top = facts.find((f) => f.memoryId === aFact.id)!;
    expect(top.status).toBe('active');
    expect(top.sensitive).toBe(false);
    expect(top.sourceType).toBe('user_note');
    expect(top.sourceId).toBe('note-a1');
    expect(top.signals.length).toBeGreaterThan(0);
    expect(top.signals).toContain('entity'); // "Maja" via the query heuristic

    // The generation input is exactly the fact blocks + the question.
    const request = gateway.streamRequests.at(-1)!;
    expect(request.input).toContain(question);
    expect(request.input).toContain('Maja needs the draft contract before Thursday');
    expect(request.input).not.toContain('Vault code');
    for (const fact of facts) expect(request.input).toContain(`[${fact.marker}]`);

    // The persisted assistant message carries the stable citation form.
    const done = events.find((e) => e.type === 'done');
    expect(done?.type).toBe('done');
    const content = done!.type === 'done' ? done!.content : '';
    const f1 = facts.find((f) => f.marker === 'F1')!;
    expect(content).toContain(`[[mem:${f1.memoryId}]]`);
    expect(content).not.toContain('[F1]');
    const persisted = await tdb.db.select().from(chatMessage);
    expect(persisted.filter((m) => m.role === 'user').map((m) => m.content)).toContain(question);
    expect(persisted.filter((m) => m.role === 'assistant').map((m) => m.content)).toContain(
      content,
    );
  });

  it('chat_grounding: zero retrieval yields the nothing-on-record path — no generation from thin air', async () => {
    const callsBefore = gateway.streamRequests.length;
    const events = await collect(userEmpty, 'What is the status of the Zagreb rollout?');

    const sources = events.find((e) => e.type === 'sources');
    expect(sources!.type === 'sources' ? sources!.facts : null).toEqual([]);
    const done = events.find((e) => e.type === 'done');
    expect(done!.type === 'done' ? done!.content : '').toBe(NOTHING_ON_RECORD);
    // The gateway was never asked to generate.
    expect(gateway.streamRequests.length).toBe(callsBefore);
  });

  it('chat_fast_path: asking a question enqueues no pipeline work (§A.3 — fast path is retrieval + answering only)', async () => {
    const counts = async () => {
      const outbox = await tdb.pool.query('SELECT count(*)::int AS n FROM outbox_event');
      const jobs = await tdb.pool.query('SELECT count(*)::int AS n FROM graphile_worker.jobs');
      return { outbox: outbox.rows[0].n as number, jobs: jobs.rows[0].n as number };
    };
    const before = await counts();
    await collect(userA, 'Anything new about Maja?');
    expect(await counts()).toEqual(before);
  });
});
