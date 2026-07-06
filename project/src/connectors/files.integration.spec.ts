import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOnce } from 'graphile-worker';
import type { TaskList } from 'graphile-worker';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import { PDF_CONTENT_TYPE, DOCX_CONTENT_TYPE } from '@cogeto/shared';
import { idempotentTask } from '../infrastructure/index';
import {
  fakeEmbedding,
  makeDocx,
  makePdf,
  startTestDatabase,
  startTestMinio,
  startTestQdrant,
} from '../testing/index';
import type { TestDatabase, TestMinio, TestQdrant } from '../testing/index';
import { ModelGateway, ModelGatewayError } from '../model-gateway/index';
import type { StructuredExtractionRequest } from '../model-gateway/index';
import { createMemoryReconciliation, MemoryFileStore, MemoryObjectStore } from '../memory/index';
import type { MemoryStore, MemoryReconciliation } from '../memory/index';
import { INGESTION_PIPELINE_JOB_TYPE, createIngestionPipeline } from '../ingestion/index';
import type { IngestionPipeline } from '../ingestion/index';
import { NotesService } from './notes.service';
import { NotesSourceReader } from './notes.source-reader';
import { FilesService } from './files.service';
import { FileSourceReader } from './file.source-reader';

const DIMS = 8;
const EMBED_MODEL = 'test-embed';
const COLLECTION = 'files-conn-test';

const userA: Principal = {
  userId: 'user-a',
  name: 'User A',
  email: null,
  orgId: 'org-1',
  orgName: 'Org One',
  roles: [],
};
const userB: Principal = { ...userA, userId: 'user-b', name: 'User B' };
const userC: Principal = { ...userA, userId: 'user-c', name: 'User C', orgId: 'org-2' };

// ── Scripted gateway (deterministic) — records the extraction inputs so the
//    tests can prove the REAL extracted document text reached stage 3. ─────────

interface CandidateFactLike {
  claim: string;
  kind: string;
  entities: { people: string[]; organizations: string[]; projects: string[] };
  condition: null;
  temporal: { valid_from: null; valid_until: null; anchors_resolved: true };
  source_span: string;
}

const fact = (claim: string, entities: string[] = []): CandidateFactLike => ({
  claim,
  kind: 'commitment',
  entities: { people: entities, organizations: [], projects: [] },
  condition: null,
  temporal: { valid_from: null, valid_until: null, anchors_resolved: true },
  source_span: claim,
});

class ScriptedGateway extends ModelGateway {
  readonly extractInputs: string[] = [];

  constructor(private readonly extractOutput: () => { facts: CandidateFactLike[] }) {
    super();
  }

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
    return EMBED_MODEL;
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
      raw = { verdict: 'supported', reason: 'scripted' };
    } else {
      this.extractInputs.push(request.input);
      raw = this.extractOutput();
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelGatewayError('scripted output failed schema', false);
    return parsed.data;
  }
}

describe('file source + document pipeline (integration: real Postgres + Qdrant + MinIO)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let minio: TestMinio;
  let objects: MemoryObjectStore;
  let store: MemoryStore;
  let reconciliation: MemoryReconciliation;
  let fileStore: MemoryFileStore;
  let filesService: FilesService;
  let notes: NotesService;

  const uploadOpts = { uploadMaxBytes: 25 * 1024 * 1024, downloadUrlTtlSeconds: 300 };

  beforeAll(async () => {
    [tdb, qdrant, minio] = await Promise.all([
      startTestDatabase(),
      startTestQdrant(),
      startTestMinio(),
    ]);
    objects = new MemoryObjectStore({
      url: minio.url,
      accessKey: minio.accessKey,
      secretKey: minio.secretKey,
      bucket: 'cogeto',
    });
    await objects.ensureBucket();
    await objects.setBucketEncryption();

    ({ store, reconciliation } = createMemoryReconciliation({
      db: tdb.db,
      qdrant: {
        url: qdrant.url,
        embeddingModel: EMBED_MODEL,
        dimensions: DIMS,
        collection: COLLECTION,
      },
    }));
    await store.ensureIndexReady();
    fileStore = new MemoryFileStore(tdb.db);
    filesService = new FilesService(tdb.db, objects, fileStore, uploadOpts);
    notes = new NotesService(tdb.db);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop(), minio.stop()]);
  });

  // ── Harness ──────────────────────────────────────────────────────────────

  const buildPipeline = (gateway: ScriptedGateway) =>
    createIngestionPipeline({
      readers: [new FileSourceReader(fileStore, objects), new NotesSourceReader(tdb.db)],
      gateway,
      store,
      reconciliation,
    });

  const taskListFor = (pipeline: IngestionPipeline): TaskList => ({
    [INGESTION_PIPELINE_JOB_TYPE]: idempotentTask(
      tdb.db,
      INGESTION_PIPELINE_JOB_TYPE,
      async (tx, payload) => {
        await pipeline.run(tx, payload);
      },
    ),
  });
  const runWorker = (pipeline: IngestionPipeline) =>
    runOnce({ pgPool: tdb.pool, taskList: taskListFor(pipeline) });

  const memoriesFor = (sourceType: string, sourceId: string) =>
    tdb.pool.query<{
      id: string;
      content: string;
      status: string;
      scope: string;
      sensitive: boolean;
    }>(
      `SELECT id, content, status, scope, sensitive FROM memory
       WHERE source_type = $1 AND source_id = $2 ORDER BY content`,
      [sourceType, sourceId],
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
  const fileMetaExists = async (objectKey: string): Promise<boolean> => {
    const { rows } = await tdb.pool.query('SELECT 1 FROM file_metadata WHERE object_key = $1', [
      objectKey,
    ]);
    return rows.length > 0;
  };
  const pipelineJobCount = async (): Promise<number> => {
    const { rows } = await tdb.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM graphile_worker.jobs WHERE task_identifier = $1',
      [INGESTION_PIPELINE_JOB_TYPE],
    );
    return Number(rows[0]!.n);
  };

  // ── Tests ────────────────────────────────────────────────────────────────

  it('upload_transactional: object + metadata + job commit together; an aborted store leaves nothing and cleans the orphan', async () => {
    const before = await pipelineJobCount();
    const { objectKey } = await filesService.upload(
      userA,
      {
        buffer: makePdf('Ana will send the Atlas proposal.'),
        originalName: 'atlas.pdf',
        mimeType: PDF_CONTENT_TYPE,
      },
      { scope: 'private', sensitive: false },
    );
    expect(await objects.objectExists(objectKey)).toBe(true);
    expect(await fileMetaExists(objectKey)).toBe(true);
    expect(await pipelineJobCount()).toBe(before + 1);

    // Abort path: the metadata insert fails AFTER the object PUT → the whole
    // transaction rolls back (no metadata, no job) and the orphan object is
    // cleaned by the compensating delete (handoff §1 safe order).
    let captured = '';
    const brokenFiles = {
      record: async (_tx: unknown, row: { objectKey: string }) => {
        captured = row.objectKey;
        throw new Error('boom — injected failure after the object landed');
      },
      get: async () => null,
    } as unknown as MemoryFileStore;
    const brokenService = new FilesService(tdb.db, objects, brokenFiles, uploadOpts);

    const jobsBefore = await pipelineJobCount();
    await expect(
      brokenService.upload(
        userA,
        {
          buffer: makePdf('This upload must leave no trace.'),
          originalName: 'ghost.pdf',
          mimeType: PDF_CONTENT_TYPE,
        },
        { scope: 'private', sensitive: false },
      ),
    ).rejects.toThrow(/boom/);

    expect(captured).not.toBe('');
    expect(await objects.objectExists(captured)).toBe(false); // orphan cleaned
    expect(await fileMetaExists(captured)).toBe(false); // no metadata
    expect(await pipelineJobCount()).toBe(jobsBefore); // no job enqueued
  });

  it('file_pipeline_parity: a PDF and a DOCX flow through the SAME stages as a note; real text is extracted; facts verify with file provenance', async () => {
    const pdfText = 'Ana will send the Atlas proposal to Marko on Friday.';
    const docxText = 'Marko approved the Q3 budget of forty-eight thousand euros.';

    // PDF upload → real pdf-parse extraction → pipeline.
    const gateway = new ScriptedGateway(() => ({ facts: [fact(pdfText, ['Ana', 'Marko'])] }));
    const pipeline = buildPipeline(gateway);
    const { objectKey: pdfKey } = await filesService.upload(
      userA,
      { buffer: makePdf(pdfText), originalName: 'proposal.pdf', mimeType: PDF_CONTENT_TYPE },
      { scope: 'private', sensitive: false },
    );
    await runWorker(pipeline);

    // The REAL extracted document text reached stage 3 (not a stub).
    expect(gateway.extractInputs.some((input) => input.includes(pdfText))).toBe(true);
    const pdfRows = (await memoriesFor('file', pdfKey)).rows;
    expect(pdfRows).toHaveLength(1);
    expect(pdfRows[0]!.status).toBe('active'); // supported → active, same rule as notes
    expect(pdfRows[0]!.scope).toBe('private');
    expect(await pointsFor(pdfKey)).toHaveLength(1);
    const verification = await tdb.pool.query<{ verdict: string }>(
      `SELECT vr.verdict FROM verification_result vr JOIN memory m ON m.id = vr.memory_id
       WHERE m.source_type = 'file' AND m.source_id = $1`,
      [pdfKey],
    );
    expect(verification.rows).toEqual([{ verdict: 'supported' }]);

    // DOCX upload → real mammoth extraction → pipeline.
    const docxGateway = new ScriptedGateway(() => ({ facts: [fact(docxText, ['Marko'])] }));
    const docxPipeline = buildPipeline(docxGateway);
    const { objectKey: docxKey } = await filesService.upload(
      userA,
      { buffer: makeDocx([docxText]), originalName: 'budget.docx', mimeType: DOCX_CONTENT_TYPE },
      { scope: 'private', sensitive: false },
    );
    await runWorker(docxPipeline);
    expect(docxGateway.extractInputs.some((input) => input.includes(docxText))).toBe(true);
    const docxRows = (await memoriesFor('file', docxKey)).rows;
    expect(docxRows).toHaveLength(1);
    expect(docxRows[0]!.status).toBe('active');

    // The same pipeline over the SAME fact as a NOTE yields the same shape,
    // differing only in provenance (source_type user_note vs file).
    const noteGateway = new ScriptedGateway(() => ({ facts: [fact(pdfText, ['Ana', 'Marko'])] }));
    const notePipeline = buildPipeline(noteGateway);
    const note = await notes.createNote(userB, pdfText); // userB isolates A's memory
    await runWorker(notePipeline);
    const noteRows = (await memoriesFor('user_note', note.id)).rows;
    expect(noteRows).toHaveLength(1);
    expect(noteRows[0]!.status).toBe(pdfRows[0]!.status); // identical admission outcome
  });

  it('extraction_failure_safe: a corrupt document reaches an error state and stores zero memories', async () => {
    const gateway = new ScriptedGateway(() => ({ facts: [fact('should never be produced')] }));
    const pipeline = buildPipeline(gateway);
    const { objectKey } = await filesService.upload(
      userA,
      {
        buffer: Buffer.from('%PDF-1.4 not really a pdf at all'),
        originalName: 'broken.pdf',
        mimeType: PDF_CONTENT_TYPE,
      },
      { scope: 'private', sensitive: false },
    );
    // Fail fast: one attempt, then dead-letter (same semantics as exhausting the cap).
    await tdb.pool.query(
      "UPDATE graphile_worker._private_jobs SET max_attempts = 1 WHERE payload->>'source_id' = $1",
      [objectKey],
    );
    await runWorker(pipeline);

    expect(await filesService.getProcessingState(objectKey)).toBe('error');
    expect((await memoriesFor('file', objectKey)).rows).toHaveLength(0); // no fabricated memory
    expect(gateway.extractInputs).toHaveLength(0); // never reached extraction
    const dead = await tdb.pool.query(
      "SELECT 1 FROM dead_letter WHERE job_type = $1 AND payload->>'source_id' = $2",
      [INGESTION_PIPELINE_JOB_TYPE, objectKey],
    );
    expect(dead.rows).toHaveLength(1); // visible in the System dead-letter view
    // The original + metadata survive an extraction failure (only the saga erases).
    expect(await objects.objectExists(objectKey)).toBe(true);
    expect(await fileMetaExists(objectKey)).toBe(true);
  });

  it('signed_url_gated: sensitive files gate download to the owner; shared non-sensitive files are org-shareable', async () => {
    // A sensitive private file: only its owner gets a URL or the drawer facts.
    const { objectKey: secret } = await filesService.upload(
      userA,
      {
        buffer: makePdf('Confidential salary review.'),
        originalName: 'salary.pdf',
        mimeType: PDF_CONTENT_TYPE,
      },
      { scope: 'private', sensitive: true },
    );
    const ownerLink = await filesService.getDownloadUrl(userA, secret);
    expect(ownerLink?.url).toContain('X-Amz-Signature=');
    expect(ownerLink?.url).toContain('X-Amz-Expires=300');
    expect(await filesService.getDownloadUrl(userB, secret)).toBeNull(); // non-owner, sensitive
    expect(await filesService.getSourceForOwner(userB, secret)).toBeNull(); // owner-only drawer

    // A shared, non-sensitive file: a same-org peer may download it; a
    // different-org user may not (the object key's org segment is the gate).
    const { objectKey: shared } = await filesService.upload(
      userA,
      {
        buffer: makePdf('Team offsite agenda.'),
        originalName: 'offsite.pdf',
        mimeType: PDF_CONTENT_TYPE,
      },
      { scope: 'shared', sensitive: false },
    );
    expect((await filesService.getDownloadUrl(userB, shared))?.url).toContain('X-Amz-Signature=');
    expect(await filesService.getDownloadUrl(userC, shared)).toBeNull(); // other org

    // Even shared, a SENSITIVE file never leaves its owner.
    const { objectKey: sharedSecret } = await filesService.upload(
      userA,
      {
        buffer: makePdf('Shared but sensitive.'),
        originalName: 's.pdf',
        mimeType: PDF_CONTENT_TYPE,
      },
      { scope: 'shared', sensitive: true },
    );
    expect(await filesService.getDownloadUrl(userB, sharedSecret)).toBeNull();
  });

  it('upload_type_rejected: a non-PDF/DOCX upload is refused at the boundary and stores nothing', async () => {
    const before = await pipelineJobCount();
    await expect(
      filesService.upload(
        userA,
        {
          buffer: Buffer.from('plain text file'),
          originalName: 'notes.txt',
          mimeType: 'text/plain',
        },
        { scope: 'private', sensitive: false },
      ),
    ).rejects.toThrow(/unsupported file type/i);
    expect(await pipelineJobCount()).toBe(before); // nothing enqueued
  });
});
