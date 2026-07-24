import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatStreamEvent, Principal } from '@cogeto/shared';
import { fakeEmbedding, startTestDatabase, startTestQdrant } from '../../testing/index';
import type { TestDatabase, TestQdrant } from '../../testing/index';
import { applyMigrations } from '../../infrastructure/index';
import { createMemoryReconciliation } from '../../memory/index';
import type { MemoryStore } from '../../memory/index';
import { createIngestionPipeline } from '../../ingestion/index';
import { TasksEngine } from '../../tasks/index';
import { UserDirectory } from '../../identity/index';
import { ModelGateway, ModelGatewayError } from '../../model-gateway/index';
import type { StructuredExtractionRequest } from '../../model-gateway/index';
import type { ZodType } from 'zod';
import { RetrievalService } from '../retrieval.service';
import { ChatService } from './chat.service';
import { ChatSourceReader } from './chat.source-reader';

/**
 * Multiple conversations (P6.9; decision 0056) — the model and its scoping:
 *
 *   messages_scoped       — context assembly for a reply uses ONLY the current
 *                           conversation's turns; a fact stated raw in
 *                           conversation 1 never rides turn context into
 *                           conversation 2.
 *   memory_continuity     — a fact CAPTURED to memory in conversation 1 IS
 *                           retrievable and cited in conversation 2: memory is
 *                           the continuity, conversations are workspaces.
 *   migration_preserves   — pre-0031 messages land in the per-user "Earlier
 *                           conversation" container; chat-derived provenance
 *                           keeps resolving.
 *   conversations_gated   — user B never lists, reads, renames, archives or
 *                           asks into user A's conversations.
 *   stream_switch_clean   — an abandoned stream leaves its message in ITS
 *                           conversation; the next thread's context is clean.
 */

const DIMS = 8;
const EMBED = 'test-embed';

const principalFor = (userId: string): Principal => ({
  userId,
  name: `name-${userId}`,
  email: null,
  orgId: `org-${userId}`,
  orgName: `org-${userId}`,
  roles: [],
});

/** Scripted rewriter/answer gateway (records inputs — the scoping evidence). */
class ScriptedGateway extends ModelGateway {
  structuredCalls: string[] = [];
  streamCalls: string[] = [];
  streamText = 'Understood.';
  complete(): never {
    throw new Error('unused');
  }
  async *completeStream(request: { input: string }): AsyncIterable<string> {
    this.streamCalls.push(request.input);
    yield this.streamText;
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => fakeEmbedding(t, DIMS));
  }
  embeddingModelId(): string {
    return EMBED;
  }
  async extractStructured<T>(_schema: unknown, request: { input: string }): Promise<T> {
    this.structuredCalls.push(request.input);
    return {
      rewritten_query: request.input.split('QUESTION:').pop()?.trim() ?? 'q',
      entities: [],
      temporal: null,
      open_loops: null,
      question_class: 'personal',
    } as T;
  }
}

/** Pipeline gateway for the capture path (extract → verify → embed). */
class CaptureGateway extends ModelGateway {
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
              (() => {
                const content = request.input.split('SOURCE CONTENT:\n')[1] ?? request.input;
                return {
                  claim: content,
                  kind: 'fact',
                  entities: { people: [], organizations: ['Adriatic Foods'], projects: [] },
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

describe('multiple conversations (integration, real Postgres + Qdrant)', () => {
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

  const scriptedChat = (gateway: ScriptedGateway) => {
    const tasksEngine = new TasksEngine(tdb.db, store, gateway);
    const retrieval = new RetrievalService(store, gateway, tasksEngine);
    return new ChatService(tdb.db, retrieval, gateway, new UserDirectory(tdb.db));
  };
  const drain = async (events: AsyncGenerator<ChatStreamEvent>) => {
    const all: ChatStreamEvent[] = [];
    for await (const event of events) all.push(event);
    return all;
  };

  it('messages_scoped: a reply consumes turns from the CURRENT conversation only', async () => {
    const principal = principalFor(`conv-scope-${randomUUID()}`);
    const gateway = new ScriptedGateway();
    const chat = scriptedChat(gateway);
    const one = await chat.createConversation(principal);
    const two = await chat.createConversation(principal);

    // A distinctive fact stated raw (never captured) in conversation 1.
    await drain(chat.ask(principal, 'The Meridian door code is 4177', one.id));
    // Two turns in conversation 2 — its own context.
    await drain(chat.ask(principal, 'I am preparing the Adriatic proposal', two.id));
    gateway.structuredCalls = [];
    await drain(chat.ask(principal, 'What should I do next?', two.id));

    // The rewriter's RECENT TURNS came from conversation 2 alone.
    const rewriterInput = gateway.structuredCalls[0]!;
    expect(rewriterInput).toContain('Adriatic proposal');
    expect(rewriterInput).not.toContain('4177');

    // And each message landed in the conversation it was sent to.
    const pageOne = await chat.listMessages(principal, one.id);
    const pageTwo = await chat.listMessages(principal, two.id);
    expect(pageOne.items.some((m) => m.content.includes('4177'))).toBe(true);
    expect(pageTwo.items.some((m) => m.content.includes('4177'))).toBe(false);
  });

  it('memory_continuity: a fact captured in conversation 1 is retrieved and cited in conversation 2', async () => {
    const principal = principalFor(`conv-cont-${randomUUID()}`);
    const capture = new CaptureGateway();
    const pipeline = createIngestionPipeline({
      readers: [new ChatSourceReader(tdb.db)],
      gateway: capture,
      store,
      reconciliation,
    });
    const gateway = new ScriptedGateway();
    gateway.streamText = 'Adriatic Foods uses HubSpot [F1].';
    const chat = scriptedChat(gateway);

    // Conversation 1: state the fact and capture it through the REAL pipeline.
    const one = await chat.createConversation(principal);
    await drain(chat.ask(principal, 'Adriatic Foods uses HubSpot as their CRM', one.id));
    const messages = await chat.listMessages(principal, one.id);
    const stated = messages.items.find((m) => m.role === 'user')!;
    await chat.rememberMessage(principal, stated.id);
    await tdb.db.transaction((tx) =>
      pipeline.run(tx, { source_type: 'chat', source_id: stated.id }),
    );

    // Conversation 2: the fact answers here, cited, via memory retrieval.
    const two = await chat.createConversation(principal);
    const events = await drain(chat.ask(principal, 'What CRM does Adriatic Foods use?', two.id));
    const sources = events.find((e) => e.type === 'sources');
    const facts = sources && sources.type === 'sources' ? sources.facts : [];
    expect(facts.length).toBeGreaterThan(0);
    const cited = facts.find((f) => (f.claim ?? '').includes('HubSpot'))!;
    expect(cited).toBeDefined();
    // Provenance still points at the conversation-1 message.
    expect(cited.sourceType).toBe('chat');
    expect(cited.sourceId).toBe(stated.id);
    const done = events.find((e) => e.type === 'done');
    expect(done && done.type === 'done' ? done.content : '').toContain(
      `{{cite:${cited.memoryId}}}`,
    );
  });

  it('conversations_gated: user B never lists, reads, renames, archives or asks into user A’s conversations', async () => {
    const userA = principalFor(`conv-gate-a-${randomUUID()}`);
    const userB = principalFor(`conv-gate-b-${randomUUID()}`);
    const gateway = new ScriptedGateway();
    const chat = scriptedChat(gateway);
    const mine = await chat.createConversation(userA);
    await drain(chat.ask(userA, 'A private planning note to myself', mine.id));

    const bList = await chat.listConversations(userB);
    expect(bList.map((c) => c.id)).not.toContain(mine.id);
    await expect(chat.listMessages(userB, mine.id)).rejects.toThrow(/not found/i);
    await expect(chat.renameConversation(userB, mine.id, 'stolen')).rejects.toThrow(/not found/i);
    await expect(chat.setConversationArchived(userB, mine.id, true)).rejects.toThrow(/not found/i);
    await expect(chat.assertConversation(userB, mine.id)).rejects.toThrow(/not found/i);
    await expect(drain(chat.ask(userB, 'What is in here?', mine.id))).rejects.toThrow(/not found/i);
  });

  it('stream_switch_clean: an abandoned stream leaves its message in ITS conversation; the next thread is clean', async () => {
    const principal = principalFor(`conv-switch-${randomUUID()}`);
    const gateway = new ScriptedGateway();
    const chat = scriptedChat(gateway);
    const one = await chat.createConversation(principal);
    const two = await chat.createConversation(principal);

    // Start a stream in conversation 1, then detach after the first event —
    // the controller's abort path does exactly this via iterator.return().
    const stream = chat.ask(principal, 'Long question in thread one', one.id);
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.(undefined);

    // Switch: a full ask in conversation 2.
    gateway.structuredCalls = [];
    await drain(chat.ask(principal, 'Fresh question in thread two', two.id));

    // The abandoned turn landed in conversation 1 — and ONLY there.
    const pageOne = await chat.listMessages(principal, one.id);
    const pageTwo = await chat.listMessages(principal, two.id);
    expect(pageOne.items.some((m) => m.content.includes('thread one'))).toBe(true);
    expect(pageTwo.items.some((m) => m.content.includes('thread one'))).toBe(false);
    // And thread two's context never saw thread one's turn.
    expect(gateway.structuredCalls[0]).not.toContain('thread one');
  });

  it('archive_preserves: an archived conversation keeps everything and stays retrievable-from via memory', async () => {
    const principal = principalFor(`conv-arch-${randomUUID()}`);
    const capture = new CaptureGateway();
    const pipeline = createIngestionPipeline({
      readers: [new ChatSourceReader(tdb.db)],
      gateway: capture,
      store,
      reconciliation,
    });
    const gateway = new ScriptedGateway();
    gateway.streamText = 'Adriatic Foods pays net 30 [F1].';
    const chat = scriptedChat(gateway);

    const archivedConv = await chat.createConversation(principal);
    await drain(chat.ask(principal, 'Adriatic Foods pays invoices net 30', archivedConv.id));
    const messages = await chat.listMessages(principal, archivedConv.id);
    const stated = messages.items.find((m) => m.role === 'user')!;
    await chat.rememberMessage(principal, stated.id);
    await tdb.db.transaction((tx) =>
      pipeline.run(tx, { source_type: 'chat', source_id: stated.id }),
    );

    await chat.setConversationArchived(principal, archivedConv.id, true);

    // Everything kept: the thread and its messages are still readable.
    const kept = await chat.listMessages(principal, archivedConv.id);
    expect(kept.total).toBe(messages.total);
    // And the captured memory still answers from ANOTHER conversation.
    const fresh = await chat.createConversation(principal);
    const events = await drain(
      chat.ask(principal, 'What are Adriatic Foods payment terms?', fresh.id),
    );
    const sources = events.find((e) => e.type === 'sources');
    const facts = sources && sources.type === 'sources' ? sources.facts : [];
    expect(facts.some((f) => (f.claim ?? '').includes('net 30'))).toBe(true);
  });

  it('conversation_lifecycle: rename wins and persists; archive flips; the list orders by recency with previews', async () => {
    const principal = principalFor(`conv-life-${randomUUID()}`);
    const gateway = new ScriptedGateway();
    const chat = scriptedChat(gateway);
    const first = await chat.createConversation(principal);
    const second = await chat.createConversation(principal);
    await drain(chat.ask(principal, 'Only the second thread has messages', second.id));

    const renamed = await chat.renameConversation(principal, first.id, 'Client A prep');
    expect(renamed.title).toBe('Client A prep');
    expect(renamed.titleSetByUser).toBe(true);

    const archived = await chat.setConversationArchived(principal, first.id, true);
    expect(archived.archived).toBe(true);

    const list = await chat.listConversations(principal);
    const listedSecond = list.find((c) => c.id === second.id)!;
    // Recency: the thread with the newest message leads.
    expect(list[0]!.id).toBe(second.id);
    expect(listedSecond.lastMessagePreview).toBeTruthy();
    expect(list.find((c) => c.id === first.id)!.archived).toBe(true);
  });
});

describe('migration_preserves (raw container: pre-0031 history → the legacy container)', () => {
  it('existing messages land in "Earlier conversation" per user; chat provenance keeps resolving', async () => {
    const container = await new PostgreSqlContainer('postgres:17-alpine').start();
    const pool = new Pool({ connectionString: container.getConnectionUri() });
    try {
      // Apply everything BEFORE 0031 from a filtered copy of the real dir.
      const allDir = path.resolve(__dirname, '..', '..', 'migrations');
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cogeto-mig-'));
      for (const file of (await fs.readdir(allDir)).filter((f) => f.endsWith('.sql')).sort()) {
        const id = Number.parseInt(file.split('_')[0] ?? '', 10);
        if (id < 31) await fs.copyFile(path.join(allDir, file), path.join(tempDir, file));
      }
      await applyMigrations(pool, tempDir);

      // The pre-0031 world: two users with flat chat history; one message has
      // a chat-derived memory citing it.
      const insert = async (owner: string, role: string, content: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO chat_message (owner_id, role, content) VALUES ($1, $2::chat_role, $3) RETURNING id`,
          [owner, role, content],
        );
        return rows[0]!.id;
      };
      const a1 = await insert('user-a', 'user', 'We chose Postgres for Atlas.');
      await insert('user-a', 'assistant', 'Noted.');
      const b1 = await insert('user-b', 'user', 'My meeting moved to Friday.');
      await pool.query(
        `INSERT INTO memory (owner_id, scope, source_type, source_id, status, content)
         VALUES ('user-a', 'private', 'chat', $1, 'active', 'We chose Postgres for Atlas.')`,
        [a1],
      );

      // 0031 applies on top.
      await applyMigrations(pool, allDir);

      // One "Earlier conversation" container per user with history.
      const containers = await pool.query<{ id: string; owner_id: string; title: string }>(
        `SELECT id, owner_id, title FROM conversation ORDER BY owner_id`,
      );
      expect(containers.rows.map((r) => [r.owner_id, r.title])).toEqual([
        ['user-a', 'Earlier conversation'],
        ['user-b', 'Earlier conversation'],
      ]);

      // No orphan messages: every message sits in its owner's container.
      const orphans = await pool.query(
        `SELECT 1 FROM chat_message m
         WHERE m.conversation_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM conversation c
              WHERE c.id = m.conversation_id AND c.owner_id = m.owner_id
            )`,
      );
      expect(orphans.rows).toHaveLength(0);
      const b1Row = await pool.query<{ conversation_id: string }>(
        `SELECT conversation_id FROM chat_message WHERE id = $1`,
        [b1],
      );
      const bContainer = containers.rows.find((r) => r.owner_id === 'user-b')!;
      expect(b1Row.rows[0]!.conversation_id).toBe(bContainer.id);

      // The chat-derived memory's provenance still resolves to its message.
      const provenance = await pool.query(
        `SELECT 1 FROM memory mem
         JOIN chat_message msg ON msg.id::text = mem.source_id
         WHERE mem.source_type = 'chat' AND mem.source_id = $1`,
        [a1],
      );
      expect(provenance.rows).toHaveLength(1);
    } finally {
      await pool.end();
      await container.stop();
    }
  });
});
