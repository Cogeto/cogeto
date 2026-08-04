import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import { fakeEmbedding, startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { createMemoryReconciliation } from '../memory/index';
import type { MemoryStore } from '../memory/index';
import { createIngestionPipeline, createSuppressedFactLog } from '../ingestion/index';
import type { IngestionPipeline } from '../ingestion/index';
import { UserDirectory } from '../identity/index';
import { ModelGateway, ModelGatewayError } from '../model-gateway/index';
import type { StreamDelta } from '../model-gateway/index';
import type { StructuredExtractionRequest } from '../model-gateway/index';
import { RetrievalService } from '../retrieval/index';
import { ChatService } from './chat.service';
import { UserSettingsService } from '../settings/index';
import { ChatSourceReader } from './chat.source-reader';
import { ChatSourceDeletion } from './chat.source-deletion';
import { chatMessage, conversation } from './persistence/tables';

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
  async *completeStream(): AsyncIterable<StreamDelta> {
    throw new Error('unused');
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => fakeEmbedding(t, DIMS));
  }
  embeddingModelId(): string {
    return EMBED;
  }
  async extractStructured<T>(schema: ZodType<T>, request: StructuredExtractionRequest): Promise<T> {
    // Batched verification (verification/v0005): multi-fact
    // sources verify in one enveloped call — every claim supported, scripted.
    if (request.input.startsWith('CLAIMS UNDER REVIEW')) {
      const batch = {
        verdicts: [...request.input.matchAll(/CLAIM (\d+):/g)].map((m) => ({
          claim: Number(m[1]),
          verdict: 'supported',
          reason: 'scripted',
        })),
      };
      const parsedBatch = schema.safeParse(batch);
      if (!parsedBatch.success) throw new Error('scripted batch output failed schema');
      return parsedBatch.data;
    }
    const isVerify = request.input.startsWith('CLAIM UNDER REVIEW');
    const isReconcile = request.input.startsWith('FACT A:');
    const raw = isReconcile
      ? request.system.includes('same_fact')
        ? { verdict: 'distinct', reason: 'scripted', merged_content: null }
        : { verdict: 'compatible', direction: null, reason: 'scripted' }
      : isVerify
        ? { verdict: 'supported', reason: 'scripted' }
        : {
            // A real extractor pulls from SOURCE CONTENT only, never the metadata
            // headers — mirror that so the provenance guard (extract.stage) is
            // exercised faithfully rather than tripped by the test double.
            facts: [
              (() => {
                const content = request.input.split('SOURCE CONTENT:\n')[1] ?? request.input;
                return {
                  claim: content,
                  kind: this.kind,
                  entities: { people: ['Marko'], organizations: [], projects: [] },
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
      readers: [new ChatSourceReader(tdb.db, new UserSettingsService(tdb.db))],
      gateway,
      store,
      reconciliation,
      suppressedFacts: createSuppressedFactLog(tdb.db),
    });

  // Messages need a container since — one per owner is enough here.
  const conversationIds = new Map<string, string>();
  const seedMessage = async (
    owner: string,
    role: 'user' | 'assistant',
    content: string,
  ): Promise<string> => {
    let conversationId = conversationIds.get(owner);
    if (!conversationId) {
      const [conv] = await tdb.db.insert(conversation).values({ ownerId: owner }).returning();
      conversationId = conv!.id;
      conversationIds.set(owner, conversationId);
    }
    const [row] = await tdb.db
      .insert(chatMessage)
      .values({ ownerId: owner, conversationId, role, content })
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
    const reader = new ChatSourceReader(tdb.db, new UserSettingsService(tdb.db));
    const userId = await seedMessage(owner, 'user', 'I will send Marko the contract on Monday.');
    const assistantId = await seedMessage(owner, 'assistant', 'Noted — I will remember that.');

    const item = await reader.load(userId);
    expect(item?.sourceType).toBe('chat');
    expect(item?.ownerId).toBe(owner);
    expect(item?.content).toContain('contract');
    // The assistant's own reply can never become a source item (r4).
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
    // A user with no settings row keeps the private default (ruling 6) — but
    // it now comes from the SETTING, not from the pipeline's fallback.
    expect(rows[0]!.scope).toBe('private');
  });

  it('chat_capture_stamps_the_owners_default_scope: shared by setting, not private by default', async () => {
    // V2.0 item 3.7. The reader used to omit `scope` entirely, so
    // `embed-store.stage`'s `?? 'private'` decided it and a user whose default
    // capture scope is `shared` silently got shared memories from notes, files,
    // email and web, and private ones from chat. Both directions asserted, so a
    // regression that hardcodes either value fails.
    const sharedOwner = `chat-scope-shared-${randomUUID()}`;
    const privateOwner = `chat-scope-private-${randomUUID()}`;
    await new UserSettingsService(tdb.db).update(principalFor(sharedOwner), {
      defaultScope: 'shared',
    });

    const sharedId = await seedMessage(sharedOwner, 'user', 'We chose Postgres for Atlas.');
    const privateId = await seedMessage(privateOwner, 'user', 'We chose Postgres for Atlas.');
    const pipeline = pipelineWith(new ScriptedGateway('decision'));
    await runPipeline(pipeline, sharedId);
    await runPipeline(pipeline, privateId);

    expect((await memoriesForChat(sharedId)).rows.map((r) => r.scope)).toEqual(['shared']);
    expect((await memoriesForChat(privateId)).rows.map((r) => r.scope)).toEqual(['private']);

    // And the item the reader hands the pipeline says so itself.
    const reader = new ChatSourceReader(tdb.db, new UserSettingsService(tdb.db));
    expect((await reader.load(sharedId))?.scope).toBe('shared');
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
    // It enqueued transactionally via the outbox (spec §15.4) for the chat source.
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
