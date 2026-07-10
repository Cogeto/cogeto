import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOnce } from 'graphile-worker';
import type { TaskList } from 'graphile-worker';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import { ensureInstanceKeys, idempotentTask } from '../infrastructure/index';
import {
  fakeEmbedding,
  startTestDatabase,
  startTestMinio,
  startTestQdrant,
} from '../testing/index';
import type { TestDatabase, TestMinio, TestQdrant } from '../testing/index';
import { NotesService, NotesSourceDeletion, NotesSourceReader } from '../connectors/index';
import {
  createIngestionPipeline,
  INGESTION_PIPELINE_JOB_TYPE,
  PipelineIngestionGuard,
} from '../ingestion/index';
import type { IngestionPipeline } from '../ingestion/index';
import { ModelGateway, ModelGatewayError } from '../model-gateway/index';
import type { StructuredExtractionRequest } from '../model-gateway/index';
import { MemoryStore } from './memory.store';
import { MemoryReconciliation } from './reconciliation';
import { MemoryVectorStore } from './persistence/vector-store';
import { MemoryObjectStore } from './persistence/object-store';
import { DELETION_JOB_TYPE, DeletionExecutor, DeletionSaga } from './deletion-saga';
import { IntegritySweep } from './integrity-sweep';

const DIMS = 8;
const COLLECTION = 'deletion-race-test';

const userA: Principal = {
  userId: 'user-race',
  name: 'User Race',
  email: null,
  orgId: 'org-1',
  orgName: 'Org',
  roles: [],
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A scripted gateway whose EXTRACTION stage blocks until the test releases it —
 * the controllable stand-in for the real 5–30 s model-call window in which the
 * QS-5 race lives. Verification and reconciliation answer immediately.
 */
class SlowExtractionGateway extends ModelGateway {
  readonly extractionStarted = deferred();
  readonly releaseExtraction = deferred();

  complete(): never {
    throw new Error('complete() is not used by the pipeline');
  }
  // eslint-disable-next-line require-yield -- not used by the pipeline
  async *completeStream(): AsyncIterable<string> {
    throw new Error('completeStream() is not used by the pipeline');
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => fakeEmbedding(text, DIMS));
  }
  embeddingModelId(): string {
    return 'test-embed';
  }

  async extractStructured<T>(schema: ZodType<T>, request: StructuredExtractionRequest): Promise<T> {
    const isVerify = request.input.startsWith('CLAIM UNDER REVIEW');
    const isReconcile = request.input.startsWith('FACT A:');
    let raw: unknown;
    if (isReconcile) {
      raw = request.system.includes('same_fact')
        ? { verdict: 'distinct', reason: 'scripted', merged_content: null }
        : { verdict: 'compatible', direction: null, reason: 'scripted' };
    } else if (isVerify) {
      raw = { verdict: 'supported', reason: 'the passage states it' };
    } else {
      // Extraction: signal the test, then hold the pipeline transaction open
      // until the deletion has run mid-flight.
      this.extractionStarted.resolve();
      await this.releaseExtraction.promise;
      raw = {
        facts: [
          {
            claim: 'Novira agreed to a €48,000 Q3 renewal.',
            kind: 'commitment',
            entities: { people: [], organizations: ['Novira'], projects: [] },
            condition: null,
            temporal: { valid_from: null, valid_until: null, anchors_resolved: true },
            source_span: 'Novira agreed to a €48,000 Q3 renewal.',
          },
        ],
      };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new ModelGatewayError('scripted output failed schema validation', false);
    }
    return parsed.data;
  }
}

describe('QS-5 delete-vs-ingestion race (integration: real Postgres + Qdrant, real saga + pipeline)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let minio: TestMinio;
  let keyDir: string;
  let vectors: MemoryVectorStore;
  let store: MemoryStore;
  let notes: NotesService;
  let saga: DeletionSaga;
  let executor: DeletionExecutor;
  let sweep: IntegritySweep;

  beforeAll(async () => {
    [tdb, qdrant, minio] = await Promise.all([
      startTestDatabase(),
      startTestQdrant(),
      startTestMinio(),
    ]);
    keyDir = mkdtempSync(path.join(tmpdir(), 'cogeto-instance-keys-'));
    await ensureInstanceKeys(keyDir);
    vectors = new MemoryVectorStore({
      url: qdrant.url,
      embeddingModel: 'test-embed',
      dimensions: DIMS,
      collection: COLLECTION,
    });
    await vectors.ensureCollection();
    store = new MemoryStore(tdb.db, vectors);
    notes = new NotesService(tdb.db);
    saga = new DeletionSaga(
      tdb.db,
      [new NotesSourceDeletion()],
      undefined,
      [],
      new PipelineIngestionGuard(),
    );
    // Real MinIO: the sweep's orphan-object arm (QS-28) lists the bucket, so
    // a placeholder endpoint would fail the sweep assertions below.
    const objects = new MemoryObjectStore({
      url: minio.url,
      accessKey: minio.accessKey,
      secretKey: minio.secretKey,
      bucket: 'cogeto',
    });
    await objects.ensureBucket();
    executor = new DeletionExecutor(vectors, objects, keyDir);
    sweep = new IntegritySweep(tdb.db, vectors, objects, keyDir, [new NotesSourceDeletion()]);
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop(), minio.stop()]);
  });

  const buildPipeline = (gateway: ModelGateway): IngestionPipeline =>
    createIngestionPipeline({
      readers: [new NotesSourceReader(tdb.db)],
      gateway,
      store,
      reconciliation: new MemoryReconciliation(tdb.db, store, vectors),
    });
  const taskListFor = (pipeline: IngestionPipeline): TaskList => ({
    [INGESTION_PIPELINE_JOB_TYPE]: idempotentTask(
      tdb.db,
      INGESTION_PIPELINE_JOB_TYPE,
      async (tx, payload) => {
        await pipeline.run(tx, payload);
      },
    ),
    [DELETION_JOB_TYPE]: idempotentTask(tdb.db, DELETION_JOB_TYPE, async (tx, payload) => {
      await executor.execute(tx, payload.source_id);
    }),
  });

  const count = async (sql: string, params: unknown[] = []): Promise<number> => {
    const { rows } = await tdb.pool.query<{ n: string }>(sql, params);
    return Number(rows[0]?.n ?? 0);
  };
  const memoryCount = (sourceId: string) =>
    count(
      `SELECT count(*)::text AS n FROM memory WHERE source_type = 'user_note' AND source_id = $1`,
      [sourceId],
    );
  const pointsFor = async (sourceId: string): Promise<unknown[]> => {
    const response = await fetch(`${qdrant.url}/collections/${COLLECTION}/points/scroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        limit: 100,
        filter: { must: [{ key: 'source_id', match: { value: sourceId } }] },
      }),
    });
    const body = (await response.json()) as { result: { points: unknown[] } };
    return body.result.points;
  };

  it('deletion_mid_extraction: a source deleted while its pipeline job is mid-extraction resurrects nothing — no rows, no points, honest receipt, no-op job', async () => {
    const gateway = new SlowExtractionGateway();
    const pipeline = buildPipeline(gateway);

    // A REAL captured note: the row + the pipeline job enqueue commit together.
    const note = await notes.createNote(userA, 'Novira agreed to a €48,000 Q3 renewal.');

    // Start the worker; the job claims its idempotency key + run lock, loads
    // the note, and parks inside extraction with the transaction held open.
    const workerRun = runOnce({ pgPool: tdb.pool, taskList: taskListFor(pipeline) });
    await gateway.extractionStarted.promise;

    // Mid-flight deletion. This must complete WITHOUT waiting for the pipeline
    // (the extraction gate is still closed — a blocking implementation would
    // hang here until the test times out): the guard reports the in-flight run
    // and leaves it to the admission checkpoint.
    const { receiptId } = await saga.requestSourceDeletion(userA, 'user_note', note.id);

    // Release the model call; the pipeline reaches its admission checkpoint,
    // finds the note gone, and aborts as a no-op. The worker then also runs
    // the deletion job, confirming the receipt.
    gateway.releaseExtraction.resolve();
    await workerRun;

    // Provable forgetting held: nothing derived from the erased source exists.
    expect(await memoryCount(note.id)).toBe(0);
    expect(await pointsFor(note.id)).toHaveLength(0);

    // The receipt is honest (nothing existed at enumeration time) + confirmed.
    const { rows: receipts } = await tdb.pool.query<{
      status: string;
      counts_json: { memory_count: number; point_ids: string[] };
      signature: string | null;
    }>(`SELECT status, counts_json, signature FROM deletion_receipt WHERE id = $1`, [receiptId]);
    expect(receipts[0]?.status).toBe('confirmed');
    expect(receipts[0]?.counts_json.memory_count).toBe(0);
    expect(receipts[0]?.signature).toBeTruthy();

    // The job completed as a NO-OP: key consumed, queue drained, nothing parked.
    expect(
      await count(
        `SELECT count(*)::text AS n FROM job_execution WHERE source_id = $1 AND job_type = $2`,
        [note.id, INGESTION_PIPELINE_JOB_TYPE],
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM graphile_worker._private_jobs WHERE payload->>'source_id' = $1`,
        [note.id],
      ),
    ).toBe(0);
    expect(await count(`SELECT count(*)::text AS n FROM dead_letter`)).toBe(0);

    // The abort left its audit trace, and the saga recorded the cancellation.
    expect(
      await count(
        `SELECT count(*)::text AS n FROM audit_log
         WHERE action = 'ingestion.admission_aborted' AND entity_id = $1`,
        [`user_note/${note.id}`],
      ),
    ).toBe(1);
    const { rows: sagaAudit } = await tdb.pool.query<{
      detail_json: { ingestionCancellation: string };
    }>(
      `SELECT detail_json FROM audit_log
       WHERE action = 'source.deletion_requested' AND entity_id = $1`,
      [receiptId],
    );
    expect(sagaAudit[0]?.detail_json.ingestionCancellation).toBe('run_in_flight');

    // The nightly sweep (both orphan arms included) finds a clean instance.
    const report = await sweep.run();
    expect(report.newAlerts).toBe(0);
    expect(report.chainOk).toBe(true);
  });

  it('deletion_before_job_starts: deleting a just-captured note consumes the pipeline idempotency key — the queued job no-ops without touching the source', async () => {
    const gateway = new SlowExtractionGateway();
    // The queued job must never reach extraction; unblock it if it does so the
    // assertions below fail loudly instead of the suite hanging.
    void gateway.extractionStarted.promise.then(() => gateway.releaseExtraction.resolve());
    const pipeline = buildPipeline(gateway);

    const note = await notes.createNote(userA, 'Dario confirmed the Q4 audit date.');
    // Delete BEFORE any worker run: no run in flight → the key is consumed.
    const { receiptId } = await saga.requestSourceDeletion(userA, 'user_note', note.id);

    const { rows: sagaAudit } = await tdb.pool.query<{
      detail_json: { ingestionCancellation: string };
    }>(
      `SELECT detail_json FROM audit_log
       WHERE action = 'source.deletion_requested' AND entity_id = $1`,
      [receiptId],
    );
    expect(sagaAudit[0]?.detail_json.ingestionCancellation).toBe('cancelled');

    // The queued job now runs — and skips at its claim (duplicate key).
    await runOnce({ pgPool: tdb.pool, taskList: taskListFor(pipeline) });
    expect(await memoryCount(note.id)).toBe(0);
    expect(await pointsFor(note.id)).toHaveLength(0);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM graphile_worker._private_jobs WHERE payload->>'source_id' = $1`,
        [note.id],
      ),
    ).toBe(0);
  });

  it('orphan_sweep_arm: a memory whose source row no longer exists is flagged as an integrity violation within one sweep', async () => {
    // Simulate historical residue: a memory row pointing at a note that was
    // never (or no longer is) there — exactly what QS-5 could leave behind
    // before the fix, and what a restored backup can reintroduce.
    const ghostNoteId = '00000000-0000-4000-8000-00000000dead';
    const orphan = await store.createFromFact(userA, {
      content: 'residue from an erased source',
      scope: 'private',
      sourceType: 'user_note',
      sourceId: ghostNoteId,
    });

    const report = await sweep.run();
    expect(report.newAlerts).toBeGreaterThanOrEqual(1);
    const { rows } = await tdb.pool.query<{ kind: string; detail: string }>(
      `SELECT kind, detail FROM integrity_alert WHERE kind = 'orphaned_memory'`,
    );
    expect(rows.map((r) => r.detail)).toContain(orphan.id);

    // Clean up so this suite leaves no cross-test residue (alerts dedupe by
    // identifier, so other tests' sweep_clean assertions must run before this).
    await tdb.pool.query(`DELETE FROM memory WHERE id = $1`, [orphan.id]);
    await tdb.pool.query(`DELETE FROM integrity_alert WHERE kind = 'orphaned_memory'`);
  });
});
