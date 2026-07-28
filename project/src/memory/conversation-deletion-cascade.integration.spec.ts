import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOnce } from 'graphile-worker';
import type { TaskList } from 'graphile-worker';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import { ensureInstanceKeys, idempotentTask, loadInstancePublicKey } from '../infrastructure/index';
import {
  fakeEmbedding,
  startTestDatabase,
  startTestMinio,
  startTestQdrant,
} from '../testing/index';
import type { TestDatabase, TestMinio, TestQdrant } from '../testing/index';
import { ModelGateway, ModelGatewayError } from '../model-gateway/index';
import type { StructuredExtractionRequest } from '../model-gateway/index';
import { ChatSourceReader, ConversationSourceDeletion } from '../retrieval/index';
import { createIngestionPipeline } from '../ingestion/index';
import { MemoryStore } from './memory.store';
import { MemoryReconciliation } from './reconciliation';
import { MemoryVectorStore } from './persistence/vector-store';
import { MemoryObjectStore } from './persistence/object-store';
import {
  DELETION_JOB_TYPE,
  DeletionExecutor,
  DeletionSaga,
  parseReceiptCounts,
} from './deletion-saga';
import { verifyChain } from './domain/receipt-chain';
import type { ConfirmedReceipt } from './domain/receipt-chain';

/**
 * Conversation deletion (P6.9; decision 0056) — a source deletion through the
 * §A.7 saga, extended by enumeration only:
 *
 *   conversation_deletion_cascade — the thread's messages AND every memory
 *     derived from them (and their vectors) are gone
 *     under ONE signed receipt whose counts are honest.
 *   delete_confirm_counts — the preview's numbers (messages, memories,
 *     user_approved) match exactly what the enumeration then removes.
 */

const DIMS = 8;
const EMBED_MODEL = 'test-embed';
const COLLECTION = 'conversation-cascade-test';

const owner: Principal = {
  userId: 'user-conv-del',
  name: 'Conv Owner',
  email: 'conv@instance.test',
  orgId: 'org-conv',
  orgName: 'Org',
  roles: [],
};
const stranger: Principal = { ...owner, userId: 'user-conv-stranger' };

/** One commitment or fact per message, verify supported, reconcile distinct. */
class ScriptedGateway extends ModelGateway {
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
    return EMBED_MODEL;
  }
  async extractStructured<T>(schema: ZodType<T>, request: StructuredExtractionRequest): Promise<T> {
    // Batched verification (decision 0057; verification/v0005): multi-fact
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
    let raw: unknown;
    if (request.input.startsWith('CLAIM UNDER REVIEW')) {
      raw = { verdict: 'supported', reason: 'scripted' };
    } else if (request.input.startsWith('FACT A:')) {
      raw = { verdict: 'distinct', reason: 'scripted', merged_content: null };
    } else {
      const content = request.input.split('SOURCE CONTENT:\n')[1] ?? request.input;
      raw = {
        facts: [
          {
            claim: content,
            kind: content.includes('I will') ? 'commitment' : 'fact',
            entities: { people: ['Marko'], organizations: [], projects: [] },
            condition: null,
            temporal: { valid_from: null, valid_until: null, anchors_resolved: true },
            source_span: content.slice(0, 40),
          },
        ],
      };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelGatewayError('scripted output failed schema', false);
    return parsed.data;
  }
}

describe('conversation deletion cascade (integration: real Postgres + Qdrant + MinIO)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let minio: TestMinio;
  let keyDir: string;
  let vectors: MemoryVectorStore;
  let objects: MemoryObjectStore;
  let store: MemoryStore;
  let saga: DeletionSaga;
  let executor: DeletionExecutor;
  const gateway = new ScriptedGateway();

  beforeAll(async () => {
    [tdb, qdrant, minio] = await Promise.all([
      startTestDatabase(),
      startTestQdrant(),
      startTestMinio(),
    ]);
    keyDir = mkdtempSync(path.join(tmpdir(), 'cogeto-conv-cascade-keys-'));
    await ensureInstanceKeys(keyDir);
    vectors = new MemoryVectorStore({
      url: qdrant.url,
      embeddingModel: EMBED_MODEL,
      dimensions: DIMS,
      collection: COLLECTION,
    });
    await vectors.ensureCollection();
    objects = new MemoryObjectStore({
      url: minio.url,
      accessKey: minio.accessKey,
      secretKey: minio.secretKey,
      bucket: 'cogeto',
    });
    await objects.ensureBucket();
    store = new MemoryStore(tdb.db, vectors);
    saga = new DeletionSaga(tdb.db, [new ConversationSourceDeletion()], vectors);
    executor = new DeletionExecutor(vectors, objects, keyDir);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop(), minio.stop()]);
  });

  const pipeline = () =>
    createIngestionPipeline({
      readers: [new ChatSourceReader(tdb.db)],
      gateway,
      store,
      reconciliation: new MemoryReconciliation(tdb.db, store, vectors),
    });
  const taskList = (): TaskList => ({
    [DELETION_JOB_TYPE]: idempotentTask(tdb.db, DELETION_JOB_TYPE, async (tx, payload) => {
      await executor.execute(tx, payload.source_id);
    }),
  });
  const runWorker = () => runOnce({ pgPool: tdb.pool, taskList: taskList() });

  const seedConversation = async (ownerId: string) => {
    const conv = (
      await tdb.pool.query<{ id: string }>(
        `INSERT INTO conversation (owner_id) VALUES ($1) RETURNING id`,
        [ownerId],
      )
    ).rows[0]!.id;
    const message = async (role: string, content: string) =>
      (
        await tdb.pool.query<{ id: string }>(
          `INSERT INTO chat_message (owner_id, conversation_id, role, content)
           VALUES ($1, $2, $3::chat_role, $4) RETURNING id`,
          [ownerId, conv, role, content],
        )
      ).rows[0]!.id;
    return { conv, message };
  };

  it('conversation_deletion_cascade + delete_confirm_counts: messages, memories and vectors gone under one honest receipt', async () => {
    const { conv, message } = await seedConversation(owner.userId);
    const m1 = await message('user', `I will send Marko the mapping ${randomUUID()}`);
    const m2 = await message('user', `The Meridian archive moved to Vault B ${randomUUID()}`);
    await message('assistant', 'Noted, both of those.');

    // Both user messages captured through the REAL pipeline (source_type chat).
    for (const id of [m1, m2]) {
      await tdb.db.transaction((tx) => pipeline().run(tx, { source_type: 'chat', source_id: id }));
    }
    const memoryRows = await tdb.pool.query<{ id: string }>(
      `SELECT id FROM memory WHERE source_type = 'chat' AND source_id IN ($1, $2)`,
      [m1, m2],
    );
    const memoryIds = memoryRows.rows.map((r) => r.id);
    expect(memoryIds.length).toBeGreaterThanOrEqual(2);
    expect((await vectors.retrievePayloads(memoryIds)).size).toBe(memoryIds.length);
    // One memory carries the user's explicit approval — the confirm must say so.
    await tdb.pool.query(`UPDATE memory SET status = 'user_approved' WHERE id = $1`, [
      memoryIds[0],
    ]);

    // delete_confirm_counts: the preview's numbers match the enumeration.
    const preview = await saga.previewSourceDeletion(owner, 'chat_conversation', conv);
    expect(preview.messageCount).toBe(3);
    expect(preview.memoryCount).toBe(memoryIds.length);
    expect(preview.userApprovedCount).toBe(1);
    expect(preview.objectCount).toBe(0);

    // A stranger can neither preview nor delete it (existence must not leak).
    await expect(saga.previewSourceDeletion(stranger, 'chat_conversation', conv)).rejects.toThrow(
      /not found/i,
    );
    await expect(saga.requestSourceDeletion(stranger, 'chat_conversation', conv)).rejects.toThrow(
      /not found/i,
    );

    // Saga step one: conversation, messages and memories are gone.
    const { receiptId } = await saga.requestSourceDeletion(owner, 'chat_conversation', conv);
    const left = async (table: string, where: string, params: unknown[]) =>
      (await tdb.pool.query(`SELECT 1 FROM ${table} WHERE ${where}`, params)).rows.length;
    expect(await left('conversation', 'id = $1', [conv])).toBe(0);
    expect(await left('chat_message', 'conversation_id = $1', [conv])).toBe(0);
    expect(await left('memory', `source_type = 'chat' AND source_id IN ($1, $2)`, [m1, m2])).toBe(
      0,
    );

    // Steps two + three: vectors erased, receipt confirmed, chain verifies.
    await runWorker();
    const receipt = (
      await tdb.pool.query(`SELECT * FROM deletion_receipt WHERE id = $1`, [receiptId])
    ).rows[0] as Record<string, unknown>;
    expect(receipt['status']).toBe('confirmed');
    expect((await vectors.retrievePayloads(memoryIds)).size).toBe(0);

    // The honest receipt: every memory id and the message count.
    const counts = parseReceiptCounts(receipt['counts_json']);
    expect(new Set(counts.memory_ids)).toEqual(new Set(memoryIds));
    expect(counts.chat_messages_removed).toBe(3);
    // Never written again since decision 0060 — but still parseable (the
    // schema keeps it optional forever so historical receipts verify).
    expect(counts.tasks_removed).toBeUndefined();
    expect(counts.object_keys).toEqual([]);

    const rows = (await tdb.pool.query(`SELECT * FROM deletion_receipt WHERE status = 'confirmed'`))
      .rows as Record<string, unknown>[];
    const chain: ConfirmedReceipt[] = rows.map((r) => ({
      id: r['id'] as string,
      source_type: r['source_type'] as string,
      source_id: r['source_id'] as string,
      counts_json: r['counts_json'],
      signed_at: (r['signed_at'] as Date).toISOString(),
      confirmed_at: (r['confirmed_at'] as Date).toISOString(),
      prev_hash: r['prev_hash'] as string,
      hash: r['hash'] as string,
      signature: r['signature'] as string,
    }));
    expect(verifyChain(chain, await loadInstancePublicKey(keyDir)).ok).toBe(true);
  });
});
