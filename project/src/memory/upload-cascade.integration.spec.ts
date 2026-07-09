import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOnce } from 'graphile-worker';
import type { TaskList } from 'graphile-worker';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import { PDF_CONTENT_TYPE } from '@cogeto/shared';
import { ensureInstanceKeys, idempotentTask, loadInstancePublicKey } from '../infrastructure/index';
import {
  fakeEmbedding,
  makePdf,
  startTestDatabase,
  startTestMinio,
  startTestQdrant,
} from '../testing/index';
import type { TestDatabase, TestMinio, TestQdrant } from '../testing/index';
import { ModelGateway, ModelGatewayError } from '../model-gateway/index';
import type { StructuredExtractionRequest } from '../model-gateway/index';
import { FilesService, FileSourceReader } from '../connectors/index';
import {
  FILE_DISCARD_CLEANUP_JOB_TYPE,
  INGESTION_PIPELINE_JOB_TYPE,
  createIngestionPipeline,
} from '../ingestion/index';
import { MemoryStore } from './memory.store';
import { MemoryReconciliation } from './reconciliation';
import { MemoryVectorStore } from './persistence/vector-store';
import { MemoryObjectStore } from './persistence/object-store';
import { MemoryFileStore } from './file-store';
import { DELETION_JOB_TYPE, DeletionExecutor, DeletionSaga } from './deletion-saga';
import { IntegritySweep } from './integrity-sweep';
import { verifyChain } from './domain/receipt-chain';
import type { ConfirmedReceipt } from './domain/receipt-chain';

const DIMS = 8;
const EMBED_MODEL = 'test-embed';
const COLLECTION = 'upload-cascade-test';

const userA: Principal = {
  userId: 'user-a',
  name: 'User A',
  email: null,
  orgId: 'org-1',
  orgName: 'Org One',
  roles: [],
};

// Deterministic gateway — a fixed multi-fact extraction, supported verdicts.
interface FactLike {
  claim: string;
  kind: string;
  entities: { people: string[]; organizations: string[]; projects: string[] };
  condition: null;
  temporal: { valid_from: null; valid_until: null; anchors_resolved: true };
  source_span: string;
}
const fact = (claim: string, people: string[] = []): FactLike => ({
  claim,
  kind: 'commitment',
  entities: { people, organizations: [], projects: [] },
  condition: null,
  temporal: { valid_from: null, valid_until: null, anchors_resolved: true },
  source_span: claim,
});

class ScriptedGateway extends ModelGateway {
  constructor(private readonly extractOutput: () => { facts: FactLike[] }) {
    super();
  }
  complete(): never {
    throw new Error('unused');
  }
  // eslint-disable-next-line require-yield -- unused by the pipeline
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
    const raw = request.input.startsWith('CLAIM UNDER REVIEW')
      ? { verdict: 'supported', reason: 'scripted' }
      : request.input.startsWith('FACT A:')
        ? request.system.includes('same_fact')
          ? { verdict: 'distinct', reason: 'scripted', merged_content: null }
          : { verdict: 'compatible', direction: null, reason: 'scripted' }
        : this.extractOutput();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelGatewayError('scripted output failed schema', false);
    return parsed.data;
  }
}

describe('deletion cascade over a real uploaded file (F1 handoff §4)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let minio: TestMinio;
  let keyDir: string;
  let vectors: MemoryVectorStore;
  let objects: MemoryObjectStore;
  let store: MemoryStore;
  let fileStore: MemoryFileStore;
  let filesService: FilesService;
  let saga: DeletionSaga;
  let executor: DeletionExecutor;

  beforeAll(async () => {
    [tdb, qdrant, minio] = await Promise.all([
      startTestDatabase(),
      startTestQdrant(),
      startTestMinio(),
    ]);
    keyDir = mkdtempSync(path.join(tmpdir(), 'cogeto-o1-cascade-keys-'));
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
    await objects.setBucketEncryption();

    store = new MemoryStore(tdb.db, vectors);
    fileStore = new MemoryFileStore(tdb.db);
    filesService = new FilesService(tdb.db, objects, fileStore, store, {
      uploadMaxBytes: 25 * 1024 * 1024,
      downloadUrlTtlSeconds: 300,
    });
    saga = new DeletionSaga(tdb.db, [], vectors);
    executor = new DeletionExecutor(vectors, objects, keyDir);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop(), minio.stop()]);
  });

  let gateway: ScriptedGateway;
  const pipeline = () =>
    createIngestionPipeline({
      readers: [new FileSourceReader(fileStore, objects)],
      gateway,
      store,
      reconciliation: new MemoryReconciliation(tdb.db, store, vectors),
    });

  const taskList = (): TaskList => ({
    [INGESTION_PIPELINE_JOB_TYPE]: idempotentTask(
      tdb.db,
      INGESTION_PIPELINE_JOB_TYPE,
      async (tx, payload) => {
        await pipeline().run(tx, payload);
      },
    ),
    [DELETION_JOB_TYPE]: idempotentTask(tdb.db, DELETION_JOB_TYPE, async (tx, payload) => {
      await executor.execute(tx, payload.source_id);
    }),
    [FILE_DISCARD_CLEANUP_JOB_TYPE]: async (rawPayload) => {
      const key = (rawPayload as { source_id?: unknown }).source_id;
      if (typeof key === 'string') await objects.deleteObject(key);
    },
  });
  const runWorker = () => runOnce({ pgPool: tdb.pool, taskList: taskList() });

  const memoryCount = async (objectKey: string): Promise<number> => {
    const { rows } = await tdb.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM memory WHERE source_type = 'file' AND source_id = $1",
      [objectKey],
    );
    return Number(rows[0]!.n);
  };
  const fileMetaExists = async (objectKey: string): Promise<boolean> => {
    const { rows } = await tdb.pool.query('SELECT 1 FROM file_metadata WHERE object_key = $1', [
      objectKey,
    ]);
    return rows.length > 0;
  };
  const getReceipt = async (id: string) => {
    const { rows } = await tdb.pool.query('SELECT * FROM deletion_receipt WHERE id = $1', [id]);
    return rows[0] as { status: string; counts_json: Record<string, unknown> } | undefined;
  };
  const confirmedReceipts = async (): Promise<ConfirmedReceipt[]> => {
    const { rows } = await tdb.pool.query(
      "SELECT * FROM deletion_receipt WHERE status = 'confirmed'",
    );
    return (rows as Record<string, never>[]).map((row) => ({
      id: row['id'] as string,
      source_type: row['source_type'] as string,
      source_id: row['source_id'] as string,
      counts_json: row['counts_json'],
      signed_at: (row['signed_at'] as Date).toISOString(),
      confirmed_at: (row['confirmed_at'] as Date).toISOString(),
      prev_hash: row['prev_hash'] as string,
      hash: row['hash'] as string,
      signature: row['signature'] as string,
    }));
  };

  it('deletion_cascade_upload: a multi-fact sensitive file → bytes + metadata + memories + points all erased, receipt confirmed counting both', async () => {
    gateway = new ScriptedGateway(() => ({
      facts: [
        fact('Ana will send the Atlas proposal to Marko.', ['Ana', 'Marko']),
        fact('Marko will review the Atlas proposal by Friday.', ['Marko']),
        fact('The Atlas renewal is worth forty-eight thousand euros.'),
      ],
    }));

    const { objectKey } = await filesService.upload(
      userA,
      {
        buffer: makePdf('Ana, Marko and the Atlas renewal — a multi-fact brief.'),
        originalName: 'atlas-brief.pdf',
        mimeType: PDF_CONTENT_TYPE,
      },
      { scope: 'private', sensitive: true },
    );
    await runWorker(); // real extraction → 3 memories + 3 points

    expect(await memoryCount(objectKey)).toBe(3); // multi-memory-per-file
    // Every derived memory inherited the upload's sensitive flag (handoff).
    const sensitiveRows = await tdb.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM memory WHERE source_id = $1 AND sensitive = true',
      [objectKey],
    );
    expect(Number(sensitiveRows.rows[0]!.n)).toBe(3);
    expect(await objects.objectExists(objectKey)).toBe(true);
    expect(await fileMetaExists(objectKey)).toBe(true);
    const pointIds = (
      await tdb.pool.query<{ id: string }>('SELECT id FROM memory WHERE source_id = $1', [
        objectKey,
      ])
    ).rows.map((r) => r.id);
    expect((await vectors.retrievePayloads(pointIds)).size).toBe(3);

    // Saga step one — enumeration transaction: memories + metadata gone.
    const { receiptId } = await saga.requestSourceDeletion(userA, 'file', objectKey);
    expect(await memoryCount(objectKey)).toBe(0);
    expect(await fileMetaExists(objectKey)).toBe(false);
    expect((await getReceipt(receiptId))?.status).toBe('pending');

    // Steps two + three — worker: Qdrant points + MinIO bytes, then confirm.
    await runWorker();
    const receipt = await getReceipt(receiptId);
    expect(receipt?.status).toBe('confirmed');
    expect(await objects.objectExists(objectKey)).toBe(false);
    expect((await vectors.retrievePayloads(pointIds)).size).toBe(0);

    // The receipt counts the file object AND the memories (§B.1 provability).
    const counts = receipt!.counts_json as {
      memory_count: number;
      object_keys: string[];
      point_ids: string[];
    };
    expect(counts.memory_count).toBe(3);
    expect(counts.object_keys).toEqual([objectKey]);
    expect(counts.point_ids).toHaveLength(3);

    // The chain verifies; the nightly sweep stays clean after a real-file cascade.
    const publicKey = await loadInstancePublicKey(keyDir);
    expect(verifyChain(await confirmedReceipts(), publicKey).ok).toBe(true);
    const sweep = new IntegritySweep(tdb.db, vectors, objects, keyDir);
    expect(await sweep.run()).toMatchObject({ newAlerts: 0, openAlerts: 0, chainOk: true });
  });

  it('discard_receipt: deleting a discarded source yields a receipt with zero objects and the correct memory count', async () => {
    gateway = new ScriptedGateway(() => ({
      facts: [
        fact('Ana will circulate the discarded brief to the team.', ['Ana']),
        fact('The brief is due before the quarterly review.'),
      ],
    }));
    const { objectKey } = await filesService.upload(
      userA,
      {
        buffer: makePdf('A two-fact brief that will be discarded after extraction.'),
        originalName: 'discarded-brief.pdf',
        mimeType: PDF_CONTENT_TYPE,
      },
      { scope: 'private', sensitive: true, discard: true },
    );
    await runWorker(); // extract → 2 memories + enqueue staging cleanup
    await runWorker(); // run the staging cleanup

    // Discarded: byte-less source, no file_metadata, but memories with provenance.
    expect(await memoryCount(objectKey)).toBe(2);
    expect(await fileMetaExists(objectKey)).toBe(false);
    expect(await objects.objectExists(objectKey)).toBe(false);

    // Deletion works with no file_metadata (auth falls back to the memories'
    // owner); the receipt records the memories and ZERO object keys.
    const { receiptId } = await saga.requestSourceDeletion(userA, 'file', objectKey);
    expect(await memoryCount(objectKey)).toBe(0);
    await runWorker(); // confirm

    const receipt = await getReceipt(receiptId);
    expect(receipt?.status).toBe('confirmed');
    const counts = receipt!.counts_json as { memory_count: number; object_keys: string[] };
    expect(counts.memory_count).toBe(2);
    expect(counts.object_keys).toEqual([]); // a discarded original has no object

    const publicKey = await loadInstancePublicKey(keyDir);
    expect(verifyChain(await confirmedReceipts(), publicKey).ok).toBe(true);
  });
});
