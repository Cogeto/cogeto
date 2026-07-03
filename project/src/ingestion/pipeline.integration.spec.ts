import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOnce } from 'graphile-worker';
import type { TaskList } from 'graphile-worker';
import type { ZodType } from 'zod';
import { fakeEmbedding, startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { idempotentTask, withTransactionalEnqueue } from '../infrastructure/index';
import { createMemoryStore } from '../memory/index';
import type { MemoryStore } from '../memory/index';
import { ModelGateway, ModelGatewayError } from '../model-gateway/index';
import type { StructuredExtractionRequest } from '../model-gateway/index';
import type { CandidateFact } from './domain/candidate-fact';
import { EmbedStoreStage } from './pipeline/embed-store.stage';
import { ExtractStage } from './pipeline/extract.stage';
import { IngestionPipeline, INGESTION_PIPELINE_JOB_TYPE } from './pipeline/pipeline.service';
import type { SourceItem, SourceReader } from './pipeline/source-reader';
import { VerifyStage } from './pipeline/verify.stage';

const DIMS = 8;
const EMBED_MODEL = 'test-embed';
const COLLECTION = 'memories';

/**
 * The gateway mocked at the seam (ModelGateway) for determinism. Mirrors the
 * real gateway's contract: output that fails the Zod schema throws a
 * ModelGatewayError and is never returned to the pipeline.
 */
class ScriptedGateway extends ModelGateway {
  extractCalls = 0;
  verifyCalls = 0;
  embedCalls = 0;

  constructor(
    private readonly extractOutput: () => unknown,
    private readonly verifyOutput: (input: string) => unknown = () => ({
      verdict: 'supported',
      reason: 'scripted',
    }),
  ) {
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
    this.embedCalls += texts.length;
    return texts.map((text) => fakeEmbedding(text, DIMS));
  }
  embeddingModelId(): string {
    return EMBED_MODEL;
  }

  async extractStructured<T>(schema: ZodType<T>, request: StructuredExtractionRequest): Promise<T> {
    const isVerify = request.input.startsWith('CLAIM UNDER REVIEW');
    const raw = isVerify
      ? (this.verifyCalls++, this.verifyOutput(request.input))
      : (this.extractCalls++, this.extractOutput());
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new ModelGatewayError('structured output failed schema validation twice', false);
    }
    return parsed.data;
  }
}

/** In-test stage-1 port: the pipeline never touches connector tables. */
class FakeReader implements SourceReader {
  readonly sourceType = 'user_note' as const;
  readonly sources = new Map<string, SourceItem>();

  add(content: string): string {
    const sourceId = randomUUID();
    this.sources.set(sourceId, {
      sourceType: this.sourceType,
      sourceId,
      ownerId: 'user-pipeline',
      content,
      createdAt: new Date('2026-07-02T10:00:00Z'),
    });
    return sourceId;
  }

  async load(sourceId: string): Promise<SourceItem | null> {
    return this.sources.get(sourceId) ?? null;
  }
}

const fact = (claim: string, overrides: Partial<CandidateFact> = {}): CandidateFact => ({
  claim,
  kind: 'commitment',
  entities: { people: [], organizations: [], projects: [] },
  condition: null,
  temporal: { valid_from: null, valid_until: null, anchors_resolved: true },
  source_span: claim,
  ...overrides,
});

describe('ingestion pipeline stages 1-5 (integration, real Postgres + Qdrant, scripted gateway)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    store = createMemoryStore({
      db: tdb.db,
      qdrant: { url: qdrant.url, embeddingModel: EMBED_MODEL, dimensions: DIMS },
    });
    await store.ensureIndexReady();
  });
  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  const reader = new FakeReader();
  const buildPipeline = (gateway: ScriptedGateway, memoryStore: MemoryStore = store) =>
    new IngestionPipeline(
      [reader],
      new ExtractStage(gateway),
      new VerifyStage(gateway),
      new EmbedStoreStage(gateway, memoryStore),
    );

  const count = async (sql: string, params: unknown[] = []): Promise<number> => {
    const { rows } = await tdb.pool.query<{ n: string }>(sql, params);
    return Number(rows[0]?.n ?? 0);
  };
  const memoriesFor = (sourceId: string) =>
    tdb.pool.query<{ content: string; status: string; embedding_model: string | null }>(
      `SELECT content, status, embedding_model FROM memory
       WHERE source_type = 'user_note' AND source_id = $1`,
      [sourceId],
    );
  /** Points for a source, via plain REST (only memory may import the client). */
  const pointsFor = async (sourceId: string): Promise<unknown[]> => {
    const response = await fetch(`${qdrant.url}/collections/${COLLECTION}/points/scroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        limit: 100,
        filter: { must: [{ key: 'source_id', match: { value: sourceId } }] },
        with_payload: true,
      }),
    });
    const body = (await response.json()) as { result: { points: unknown[] } };
    return body.result.points;
  };
  const enqueue = (sourceId: string) =>
    tdb.db.transaction((tx) =>
      withTransactionalEnqueue(
        tx,
        { type: 'note.captured', payload: { source_type: 'user_note', source_id: sourceId } },
        {
          type: INGESTION_PIPELINE_JOB_TYPE,
          payload: { source_type: 'user_note', source_id: sourceId },
        },
      ),
    );
  const taskListFor = (pipeline: IngestionPipeline): TaskList => ({
    [INGESTION_PIPELINE_JOB_TYPE]: idempotentTask(
      tdb.db,
      INGESTION_PIPELINE_JOB_TYPE,
      async (tx, payload) => {
        await pipeline.run(tx, payload);
      },
    ),
  });

  it('extraction_schema_guard: malformed model output is rejected and retried, nothing stored', async () => {
    // Missing kind/entities/temporal/source_span — fails the Zod schema.
    const gateway = new ScriptedGateway(() => ({ facts: [{ claim: 'half a fact' }] }));
    const pipeline = buildPipeline(gateway);
    const sourceId = reader.add('Send the revised proposal to Luka after he confirms the budget.');

    await enqueue(sourceId);
    await runOnce({ pgPool: tdb.pool, taskList: taskListFor(pipeline) }); // attempt 1 fails

    const job = await tdb.pool.query<{ attempts: number }>(
      `SELECT attempts FROM graphile_worker._private_jobs WHERE payload->>'source_id' = $1`,
      [sourceId],
    );
    expect(job.rows[0]?.attempts).toBe(1); // still queued: retry scheduled with backoff

    // Retry it (pull run_at forward), still malformed — attempt 2, still nothing stored.
    await tdb.pool.query(`UPDATE graphile_worker._private_jobs SET run_at = now()`);
    await runOnce({ pgPool: tdb.pool, taskList: taskListFor(pipeline) });
    expect(gateway.extractCalls).toBe(2);

    expect((await memoriesFor(sourceId)).rows).toHaveLength(0);
    expect(await count('SELECT count(*)::text AS n FROM verification_result')).toBe(0);
    expect(
      await count(`SELECT count(*)::text AS n FROM job_execution WHERE source_id = $1`, [sourceId]),
    ).toBe(0);
    // Clear the poisoned job so later tests start from an empty queue.
    await tdb.pool.query(`DELETE FROM graphile_worker._private_jobs`);
  });

  it('admission_rule: supported → active; partial/unsupported → uncertain with stored verdict', async () => {
    const supported = 'Ana will send the revised proposal to Luka after he confirms the budget.';
    const partial = 'Ana will send the proposal on Friday.';
    const unsupported = 'Novira agreed to a €48,000 Q3 renewal.';
    // Route on the CLAIM line only — the verifier input also contains the
    // surrounding source text, which would otherwise match every fact.
    const verdictFor = (input: string) => {
      const claim = input.split('\n')[1] ?? '';
      if (claim === unsupported) return { verdict: 'unsupported', reason: 'only discussed' };
      if (claim === partial) return { verdict: 'partial', reason: 'no date is stated' };
      return { verdict: 'supported', reason: 'the passage states it' };
    };
    const gateway = new ScriptedGateway(
      () => ({ facts: [fact(supported), fact(partial), fact(unsupported)] }),
      verdictFor,
    );
    const pipeline = buildPipeline(gateway);
    const sourceId = reader.add('A note about the proposal, Friday and the renewal.');

    const summary = await tdb.db.transaction((tx) =>
      pipeline.run(tx, { source_type: 'user_note', source_id: sourceId }),
    );
    expect(summary.verdicts).toEqual({ supported: 1, partial: 1, unsupported: 1 });
    expect(summary.admitted).toEqual({ active: 1, uncertain: 2 });
    expect(summary.embedded).toBe(3);
    expect(gateway.verifyCalls).toBe(3); // one gateway call per fact (§B.3)

    const { rows } = await memoriesFor(sourceId);
    const byContent = new Map(rows.map((r) => [r.content, r]));
    expect(byContent.get(supported)?.status).toBe('active');
    expect(byContent.get(partial)?.status).toBe('uncertain');
    expect(byContent.get(unsupported)?.status).toBe('uncertain');
    for (const row of rows) expect(row.embedding_model).toBe(EMBED_MODEL);

    // The verdict, reason and prompt version are stored per admitted memory.
    const results = await tdb.pool.query<{ verdict: string; reason: string; pv: string }>(
      `SELECT vr.verdict, vr.reason, vr.prompt_version AS pv
       FROM verification_result vr JOIN memory m ON m.id = vr.memory_id
       WHERE m.source_id = $1`,
      [sourceId],
    );
    expect(results.rows).toHaveLength(3);
    expect(new Set(results.rows.map((r) => r.verdict))).toEqual(
      new Set(['supported', 'partial', 'unsupported']),
    );
    for (const row of results.rows) {
      expect(row.reason.length).toBeGreaterThan(0);
      expect(row.pv).toBe('verification/v0001');
    }

    // Stage 5 wrote one point per admitted memory (uncertain ones included —
    // the status multiplier, not exclusion, handles them at retrieval time).
    expect(await pointsFor(sourceId)).toHaveLength(3);
  });

  it('two_store_write_safe: a failed point write retries the job — one row, one point', async () => {
    const claim = 'Ana will send the onboarding checklist to Dario.';
    const gateway = new ScriptedGateway(() => ({ facts: [fact(claim)] }));

    // First upsert attempt fails (simulated Qdrant outage); everything after
    // succeeds. The Postgres writes share the job transaction, so attempt 1
    // must leave NO row behind, and the retry must not duplicate anything.
    let upsertFailures = 1;
    const flakyStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'upsertVectors' && upsertFailures > 0) {
          return async () => {
            upsertFailures -= 1;
            throw new Error('simulated qdrant outage');
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as MemoryStore;
    const pipeline = buildPipeline(gateway, flakyStore);
    const sourceId = reader.add('Remember to send Dario the onboarding checklist.');

    await enqueue(sourceId);
    await runOnce({ pgPool: tdb.pool, taskList: taskListFor(pipeline) }); // attempt 1: point write fails

    expect((await memoriesFor(sourceId)).rows).toHaveLength(0); // tx rolled back — no half-write
    expect(await pointsFor(sourceId)).toHaveLength(0);
    expect(
      await count(`SELECT count(*)::text AS n FROM job_execution WHERE source_id = $1`, [sourceId]),
    ).toBe(0);

    await tdb.pool.query(`UPDATE graphile_worker._private_jobs SET run_at = now()`);
    await runOnce({ pgPool: tdb.pool, taskList: taskListFor(pipeline) }); // attempt 2: succeeds

    const { rows } = await memoriesFor(sourceId);
    expect(rows).toHaveLength(1); // exactly one row —
    expect(await pointsFor(sourceId)).toHaveLength(1); // — and exactly one point
    expect(rows[0]?.embedding_model).toBe(EMBED_MODEL);
    expect(
      await count(`SELECT count(*)::text AS n FROM job_execution WHERE source_id = $1`, [sourceId]),
    ).toBe(1);
  });

  it('abstention: an empty-content source stores zero memories and completes cleanly', async () => {
    // Whitespace-only content: zero chunks, zero model calls, zero memories.
    const gateway = new ScriptedGateway(() => ({ facts: [] }));
    const pipeline = buildPipeline(gateway);
    const blankId = reader.add('   \n  ');
    const blankSummary = await tdb.db.transaction((tx) =>
      pipeline.run(tx, { source_type: 'user_note', source_id: blankId }),
    );
    expect(blankSummary.chunks).toBe(0);
    expect(gateway.extractCalls).toBe(0);
    expect((await memoriesFor(blankId)).rows).toHaveLength(0);

    // Nothing-durable content: the model abstains with facts: [] — the job
    // completes cleanly (idempotency row written, queue drained), zero memories.
    const dullId = reader.add('ok thanks, see you!');
    await enqueue(dullId);
    await runOnce({ pgPool: tdb.pool, taskList: taskListFor(pipeline) });

    expect(gateway.extractCalls).toBe(1);
    expect(gateway.verifyCalls).toBe(0);
    expect(gateway.embedCalls).toBe(0);
    expect((await memoriesFor(dullId)).rows).toHaveLength(0);
    expect(
      await count(`SELECT count(*)::text AS n FROM job_execution WHERE source_id = $1`, [dullId]),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM graphile_worker._private_jobs WHERE payload->>'source_id' = $1`,
        [dullId],
      ),
    ).toBe(0);
  });
});
