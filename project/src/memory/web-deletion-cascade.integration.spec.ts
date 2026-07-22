import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOnce } from 'graphile-worker';
import type { TaskList } from 'graphile-worker';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import {
  DailyCounters,
  ensureInstanceKeys,
  idempotentTask,
  loadInstancePublicKey,
} from '../infrastructure/index';
import {
  fakeEmbedding,
  startTestDatabase,
  startTestMinio,
  startTestQdrant,
} from '../testing/index';
import type { TestDatabase, TestMinio, TestQdrant } from '../testing/index';
import { ModelGateway, ModelGatewayError } from '../model-gateway/index';
import type { StructuredExtractionRequest } from '../model-gateway/index';
import {
  ResearchService,
  WebDiscoveryService,
  WebFetchService,
  WebSourceDeletion,
  WebSourceReader,
} from '../connectors/index';
import type { ResearchOptions } from '../connectors/index';
import { INGESTION_PIPELINE_JOB_TYPE, createIngestionPipeline } from '../ingestion/index';
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
import { createIntegritySweep } from './factory';
import { verifyChain } from './domain/receipt-chain';
import type { ConfirmedReceipt } from './domain/receipt-chain';

const DIMS = 8;
const EMBED_MODEL = 'test-embed';
const COLLECTION = 'web-cascade-test';

const owner: Principal = {
  userId: 'user-web-del',
  name: 'Web Owner',
  email: 'web@instance.test',
  orgId: 'org-web',
  orgName: 'Org',
  roles: [],
};

const PAGE = `<html><head><title>Adriatic Foods — Terms</title></head><body>
<main><p>Adriatic Foods delivers free for wholesale orders above 250 EUR.</p></main>
</body></html>`;

/** Scripted gateway: one fact per source, verify supported, reconcile distinct. */
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
    let raw: unknown;
    if (request.input.startsWith('CLAIM UNDER REVIEW')) {
      raw = { verdict: 'supported', reason: 'scripted' };
    } else if (request.input.startsWith('FACT A:')) {
      raw = { verdict: 'distinct', reason: 'scripted', merged_content: null };
    } else {
      const claim = 'Adriatic Foods delivers free for wholesale orders above 250 EUR';
      raw = {
        facts: [
          {
            claim,
            kind: 'fact',
            entities: { people: [], organizations: ['Adriatic Foods'], projects: [] },
            condition: null,
            temporal: { valid_from: null, valid_until: null, anchors_resolved: true },
            source_span: claim,
          },
        ],
      };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelGatewayError('scripted output failed schema', false);
    return parsed.data;
  }
}

const researchOptions: ResearchOptions = {
  searxngUrl: null,
  resultCap: 8,
  searchTimeoutMs: 500,
  fetchTimeoutMs: 500,
  fetchMaxBytes: 1024 * 1024,
  retainHtml: true, // exercise the optional raw-HTML object in the cascade
};

describe('web deletion cascade (integration: real Postgres + Qdrant + MinIO)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let minio: TestMinio;
  let keyDir: string;
  let vectors: MemoryVectorStore;
  let objects: MemoryObjectStore;
  let store: MemoryStore;
  let research: ResearchService;
  let saga: DeletionSaga;
  let executor: DeletionExecutor;

  beforeAll(async () => {
    [tdb, qdrant, minio] = await Promise.all([
      startTestDatabase(),
      startTestQdrant(),
      startTestMinio(),
    ]);
    keyDir = mkdtempSync(path.join(tmpdir(), 'cogeto-web-cascade-keys-'));
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

    const fetcher = new WebFetchService(researchOptions);
    fetcher.resolveAddresses = async () => ['203.0.113.10'];
    fetcher.fetchImpl = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/robots.txt')) return new Response('nope', { status: 404 });
      return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
    };
    research = new ResearchService(
      tdb.db,
      new WebDiscoveryService(researchOptions),
      fetcher,
      objects,
      new DailyCounters(),
      { searchesMax: 10, pagesMax: 10, pagesPerRunMax: 5 },
      researchOptions,
      gateway,
    );

    saga = new DeletionSaga(tdb.db, [new WebSourceDeletion()], vectors);
    executor = new DeletionExecutor(vectors, objects, keyDir);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop(), minio.stop()]);
  });

  const gateway = new ScriptedGateway();
  const pipeline = () =>
    createIngestionPipeline({
      readers: [new WebSourceReader(tdb.db)],
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
  });
  const runWorker = () => runOnce({ pgPool: tdb.pool, taskList: taskList() });

  const memCount = async (id: string): Promise<number> =>
    Number(
      (
        await tdb.pool.query(
          "SELECT count(*)::text AS n FROM memory WHERE source_type = 'web' AND source_id = $1",
          [id],
        )
      ).rows[0].n,
    );
  const receipt = async (id: string) =>
    (await tdb.pool.query('SELECT * FROM deletion_receipt WHERE id = $1', [id])).rows[0] as
      { status: string; counts_json: unknown } | undefined;

  it('web_deletion_cascade: page row + retained HTML object + memories fully removed with an honest, confirmed receipt', async () => {
    // Capture two pages: one to delete, one that must SURVIVE (and prove the
    // sweep does not flag a live web source's retained object as an orphan).
    const captured = await research.capture(owner, [
      'https://adriatic.example.org/terms',
      'https://adriatic.example.org/keep',
    ]);
    expect(captured.every((r) => r.status === 'captured')).toBe(true);
    const targetId = captured[0]!.status === 'captured' ? captured[0].id : '';
    const keeperId = captured[1]!.status === 'captured' ? captured[1].id : '';

    const rowFor = async (id: string) =>
      (await tdb.pool.query('SELECT raw_object_key FROM web_page WHERE id = $1', [id])).rows[0] as
        { raw_object_key: string | null } | undefined;
    const targetKey = (await rowFor(targetId))?.raw_object_key;
    const keeperKey = (await rowFor(keeperId))?.raw_object_key;
    expect(targetKey).toBeTruthy(); // retainHtml on → the sanitised HTML object exists
    expect(keeperKey).toBeTruthy();
    expect(await objects.objectExists(targetKey!)).toBe(true);

    // Extract both pages.
    await runWorker();
    await runWorker();
    expect(await memCount(targetId)).toBeGreaterThan(0);
    const memoryIds = (
      await tdb.pool.query<{ id: string }>(
        "SELECT id FROM memory WHERE source_type = 'web' AND source_id = $1",
        [targetId],
      )
    ).rows.map((r) => r.id);
    expect((await vectors.retrievePayloads(memoryIds)).size).toBe(memoryIds.length);

    // Preview counts the page's memories and its retained object.
    const preview = await saga.previewSourceDeletion(owner, 'web', targetId);
    expect(preview.memoryCount).toBe(memoryIds.length);
    expect(preview.objectCount).toBe(1);

    // Saga step one — enumeration transaction: row + memories gone.
    const { receiptId } = await saga.requestSourceDeletion(owner, 'web', targetId);
    expect(await memCount(targetId)).toBe(0);
    expect(await rowFor(targetId)).toBeUndefined();
    expect((await receipt(receiptId))?.status).toBe('pending');

    // Steps two + three — worker: object + points erased, receipt confirmed.
    await runWorker();
    const confirmed = await receipt(receiptId);
    expect(confirmed?.status).toBe('confirmed');
    expect(await objects.objectExists(targetKey!)).toBe(false);
    expect((await vectors.retrievePayloads(memoryIds)).size).toBe(0);

    // The receipt is honest: every memory id and the retained object key.
    const counts = parseReceiptCounts(confirmed!.counts_json);
    expect(new Set(counts.memory_ids)).toEqual(new Set(memoryIds));
    expect(counts.object_keys).toEqual([targetKey]);

    // The surviving page is untouched.
    expect(await memCount(keeperId)).toBeGreaterThan(0);
    expect(await objects.objectExists(keeperKey!)).toBe(true);

    // The chain verifies; the sweep (with the web adapter's ownsObjectKeys
    // probe) reports zero residue AND no false orphan for the keeper's object.
    const rows = (await tdb.pool.query("SELECT * FROM deletion_receipt WHERE status='confirmed'"))
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
    const publicKey = await loadInstancePublicKey(keyDir);
    expect(verifyChain(chain, publicKey).ok).toBe(true);

    const sweep = createIntegritySweep({
      db: tdb.db,
      qdrant: {
        url: qdrant.url,
        embeddingModel: EMBED_MODEL,
        dimensions: DIMS,
        collection: COLLECTION,
      },
      s3: {
        url: minio.url,
        accessKey: minio.accessKey,
        secretKey: minio.secretKey,
        bucket: 'cogeto',
      },
      instanceKeyDir: keyDir,
      sourceDeletions: [new WebSourceDeletion()],
    });
    const report = await sweep.run();
    expect(report.newAlerts).toBe(0);
    expect(report.chainOk).toBe(true);
  });
});
