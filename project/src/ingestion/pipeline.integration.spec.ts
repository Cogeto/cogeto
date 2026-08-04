import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOnce } from 'graphile-worker';
import type { TaskList } from 'graphile-worker';
import type { ZodType } from 'zod';
import { fakeEmbedding, settleJobs, startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import {
  DEFAULT_PARSE_CAPS,
  idempotentTask,
  withTransactionalEnqueue,
} from '../infrastructure/index';
import type { ParseCaps } from '../infrastructure/index';
import { createMemoryStore, MemoryReconciliation } from '../memory/index';
import type { MemoryStore } from '../memory/index';
import { ModelGateway, ModelGatewayError } from '../model-gateway/index';
import type { StreamDelta } from '../model-gateway/index';
import type { StructuredExtractionRequest } from '../model-gateway/index';
import type { CandidateFact } from './domain/candidate-fact';
import { AnchorStage } from './pipeline/anchor.stage';
import { createExtractionGateStore } from './persistence/extraction-gate.store';
import { createSourceContextStore } from './persistence/source-context.store';
import { createSuppressedFactLog } from './persistence/suppressed-fact-log';
import { EmbedStoreStage } from './pipeline/embed-store.stage';
import { ExtractStage } from './pipeline/extract.stage';
import {
  IngestionPipeline,
  INGESTION_PIPELINE_JOB_TYPE,
  WEB_MAX_FACTS,
} from './pipeline/pipeline.service';
import { ReconciliationService } from './pipeline/reconcile.stage';
import { VERIFICATION_BATCH_PROMPT } from './prompt-versions';
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
  anchorCalls = 0;
  lastExtractInput = '';
  /** The anchor answer (V2.1 item 4.2); tests override per scenario. */
  anchorOutput: () => unknown = () => ({
    subjects: [{ name: 'PWR-3100', confident: true }],
    document_class: { value: 'datasheet', confident: true },
    revision: null,
  });

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
  async *completeStream(): AsyncIterable<StreamDelta> {
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
    const isAnchor = request.input.startsWith('FILENAME:');
    const isVerify = request.input.startsWith('CLAIM UNDER REVIEW');
    // The batched form (verification/v0005): split the numbered
    // claim blocks and answer each through the same scripted verdict rule.
    const isVerifyBatch = request.input.startsWith('CLAIMS UNDER REVIEW');
    // Stage 6 may probe pairs of stored facts; these tests exercise
    // stages 1–5, so the judge conservatively rules every pair unrelated.
    const isReconcile = request.input.startsWith('FACT A:');
    const raw = isAnchor
      ? (this.anchorCalls++, this.anchorOutput())
      : isReconcile
        ? request.system.includes('same_fact')
          ? { verdict: 'distinct', reason: 'scripted', merged_content: null }
          : { verdict: 'compatible', direction: null, reason: 'scripted' }
        : isVerifyBatch
          ? (this.verifyCalls++,
            {
              verdicts: [...request.input.matchAll(/CLAIM (\d+):\n([^\n]*)/g)].map((m) => ({
                claim: Number(m[1]),
                ...(this.verifyOutput(`CLAIM UNDER REVIEW:\n${m[2]}`) as object),
              })),
            })
          : isVerify
            ? (this.verifyCalls++, this.verifyOutput(request.input))
            : (this.extractCalls++, (this.lastExtractInput = request.input), this.extractOutput());
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

  add(content: string, overrides: Partial<SourceItem> = {}): string {
    const sourceId = randomUUID();
    this.sources.set(sourceId, {
      sourceType: this.sourceType,
      sourceId,
      ownerId: 'user-pipeline',
      content,
      createdAt: new Date('2026-07-02T10:00:00Z'),
      ...overrides,
    });
    return sourceId;
  }

  async load(sourceId: string): Promise<SourceItem | null> {
    return this.sources.get(sourceId) ?? null;
  }

  /** Admission checkpoint: the in-memory map IS the durable source here. */
  async existsForAdmission(_tx: unknown, sourceId: string): Promise<boolean> {
    return this.sources.has(sourceId);
  }
}

/** File-typed stage-1 port for the anchoring tests (V2.1 item 4.2). */
class FakeFileReader implements SourceReader {
  readonly sourceType = 'file' as const;
  readonly sources = new Map<string, SourceItem>();

  add(content: string, overrides: Partial<SourceItem> = {}): string {
    const sourceId = randomUUID();
    this.sources.set(sourceId, {
      sourceType: this.sourceType,
      sourceId,
      ownerId: 'user-pipeline',
      content,
      createdAt: new Date('2026-07-02T10:00:00Z'),
      documentClass: 'pdf',
      filename: 'PWR-3000_RevB.pdf',
      ...overrides,
    });
    return sourceId;
  }

  async load(sourceId: string): Promise<SourceItem | null> {
    return this.sources.get(sourceId) ?? null;
  }

  async existsForAdmission(_tx: unknown, sourceId: string): Promise<boolean> {
    return this.sources.has(sourceId);
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
  const buildPipeline = (
    gateway: ScriptedGateway,
    memoryStore: MemoryStore = store,
    parseCaps?: Partial<ParseCaps>,
  ) =>
    new IngestionPipeline(
      [reader],
      new ExtractStage(gateway),
      new VerifyStage(gateway),
      new EmbedStoreStage(gateway, memoryStore, createSuppressedFactLog(tdb.db)),
      new ReconciliationService(
        gateway,
        memoryStore,
        new MemoryReconciliation(tdb.db, memoryStore),
      ),
      createSuppressedFactLog(tdb.db),
      parseCaps ? { ...DEFAULT_PARSE_CAPS, ...parseCaps } : undefined,
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

    // Settle first: since graphile-worker 0.17 the failure write (attempts++,
    // backoff run_at) can land after runOnce resolves.
    await settleJobs(tdb.pool);
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
    // Batched verification: three facts → ONE gateway call,
    // each claim still judged independently against its own passage (spec §2).
    expect(gateway.verifyCalls).toBe(1);

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
      // Pin to the ACTIVE batch version so a prompt bump
      // doesn't silently stale this — multi-fact sources verify batched.
      expect(row.pv).toBe(
        `${VERIFICATION_BATCH_PROMPT.family}/${VERIFICATION_BATCH_PROMPT.version}`,
      );
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

    await settleJobs(tdb.pool);
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

  it('parse_caps: chunk count and fact count are bounded', async () => {
    // A long source (many chunks) whose extractor returns several facts/chunk.
    const facts3 = () => ({
      facts: [
        fact('Ana will send the plan.'),
        fact('Ana will call Luka.'),
        fact('Ana will file it.'),
      ],
    });
    const gateway = new ScriptedGateway(facts3);
    const pipeline = buildPipeline(gateway, store, {
      maxTextChars: 1_000_000,
      maxChunks: 1, // force the chunk cap
      maxFacts: 1, // force the fact cap
      timeoutSeconds: 30,
    });
    const sourceId = reader.add('sentence. '.repeat(2000)); // ~20k chars → many chunks

    const summary = await tdb.db.transaction((tx) =>
      pipeline.run(tx, { source_type: 'user_note', source_id: sourceId }),
    );
    expect(summary.chunks).toBe(1); // capped from several
    expect(summary.extracted).toBe(1); // facts capped
    expect((await memoriesFor(sourceId)).rows).toHaveLength(1);
  });

  it('web_fact_cap: a web source is capped at WEB_MAX_FACTS salient facts', async () => {
    const webReader = new (class implements SourceReader {
      readonly sourceType = 'web' as const;
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
      async existsForAdmission(_tx: unknown, sourceId: string): Promise<boolean> {
        return this.sources.has(sourceId);
      }
    })();
    const gateway = new ScriptedGateway(() => ({
      facts: Array.from({ length: 35 }, (_, i) =>
        fact(`The regulations page states distinct rule number ${i} about mooring.`),
      ),
    }));
    const pipeline = new IngestionPipeline(
      [webReader],
      new ExtractStage(gateway),
      new VerifyStage(gateway),
      new EmbedStoreStage(gateway, store, createSuppressedFactLog(tdb.db)),
      new ReconciliationService(gateway, store, new MemoryReconciliation(tdb.db, store)),
      createSuppressedFactLog(tdb.db),
    );
    const sourceId = webReader.add('A fetched page dense with obligation-shaped rules.');
    const summary = await tdb.db.transaction((tx) =>
      pipeline.run(tx, { source_type: 'web', source_id: sourceId }),
    );
    expect(summary.extracted).toBe(WEB_MAX_FACTS); // 35 → 30, web-only budget
    expect(gateway.verifyCalls).toBe(3); // 30 claims / 10 per batched call
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

  describe('extraction_gate (V2.1 item 4.3): admission control before model spend', () => {
    const OWNER = 'user-pipeline';
    const gatedPipeline = (gateway: ScriptedGateway) =>
      new IngestionPipeline(
        [reader],
        new ExtractStage(gateway),
        new VerifyStage(gateway),
        new EmbedStoreStage(gateway, store, createSuppressedFactLog(tdb.db)),
        new ReconciliationService(gateway, store, new MemoryReconciliation(tdb.db, store)),
        createSuppressedFactLog(tdb.db),
        undefined,
        undefined,
        createExtractionGateStore(tdb.db),
      );
    const run = (pipeline: IngestionPipeline, sourceId: string) =>
      tdb.db.transaction((tx) =>
        pipeline.run(tx, { source_type: 'user_note', source_id: sourceId }),
      );
    const claim = 'Ana will send the revised proposal to Luka after he confirms the budget.';
    const clearGate = async () => {
      await tdb.pool.query(`DELETE FROM extraction_gate`);
      await tdb.pool.query(`DELETE FROM extraction_gate_rule`);
      await tdb.pool.query(`DELETE FROM extraction_gate_refusal`);
    };

    it('parity: the gate wired with no rows changes nothing', async () => {
      await clearGate();
      const gateway = new ScriptedGateway(() => ({ facts: [fact(claim)] }));
      const sourceId = reader.add(claim);
      const summary = await run(gatedPipeline(gateway), sourceId);
      expect(summary.skipped).toBeUndefined();
      expect(summary.admitted.active).toBe(1);
      expect(await count(`SELECT count(*)::text AS n FROM extraction_gate_refusal`)).toBe(0);
    });

    it('a disabled source type is refused before ANY model call, and the ledger says so', async () => {
      await clearGate();
      await tdb.pool.query(
        `INSERT INTO extraction_gate (owner_id, source_type, enabled) VALUES ($1, 'user_note', false)`,
        [OWNER],
      );
      const gateway = new ScriptedGateway(() => ({ facts: [fact(claim)] }));
      const sourceId = reader.add(claim);
      const summary = await run(gatedPipeline(gateway), sourceId);

      expect(summary.skipped).toBe('gate_refused');
      expect(gateway.extractCalls).toBe(0);
      expect(gateway.verifyCalls).toBe(0);
      expect(gateway.embedCalls).toBe(0);
      expect((await memoriesFor(sourceId)).rows).toHaveLength(0);
      const refusal = await tdb.pool.query<{ reason: string; owner_id: string }>(
        `SELECT reason, owner_id FROM extraction_gate_refusal WHERE source_id = $1`,
        [sourceId],
      );
      expect(refusal.rows).toEqual([{ reason: 'extraction_disabled', owner_id: OWNER }]);
    });

    it('a source_id deny rule switches off exactly that source', async () => {
      await clearGate();
      const gateway = new ScriptedGateway(() => ({ facts: [fact(claim)] }));
      const blocked = reader.add(claim);
      const open = reader.add(claim);
      await tdb.pool.query(
        `INSERT INTO extraction_gate_rule (owner_id, source_type, dimension, value, effect)
         VALUES ($1, 'user_note', 'source_id', $2, 'deny')`,
        [OWNER, blocked],
      );
      expect((await run(gatedPipeline(gateway), blocked)).skipped).toBe('gate_refused');
      expect((await run(gatedPipeline(gateway), open)).skipped).toBeUndefined();
      const refusal = await tdb.pool.query<{ reason: string }>(
        `SELECT reason FROM extraction_gate_refusal WHERE source_id = $1`,
        [blocked],
      );
      expect(refusal.rows[0]?.reason).toBe('source_disabled');
    });

    it('a document_class deny refuses the class and records it on the refusal', async () => {
      await clearGate();
      await tdb.pool.query(
        `INSERT INTO extraction_gate_rule (owner_id, source_type, dimension, value, effect)
         VALUES ($1, 'user_note', 'document_class', 'image', 'deny')`,
        [OWNER],
      );
      const gateway = new ScriptedGateway(() => ({ facts: [fact(claim)] }));
      const image = reader.add(claim, { documentClass: 'image' });
      const pdf = reader.add(claim, { documentClass: 'pdf' });
      const classless = reader.add(claim);

      expect((await run(gatedPipeline(gateway), image)).skipped).toBe('gate_refused');
      expect((await run(gatedPipeline(gateway), pdf)).skipped).toBeUndefined();
      expect((await run(gatedPipeline(gateway), classless)).skipped).toBeUndefined();
      const refusal = await tdb.pool.query<{ reason: string; document_class: string | null }>(
        `SELECT reason, document_class FROM extraction_gate_refusal WHERE source_id = $1`,
        [image],
      );
      expect(refusal.rows).toEqual([{ reason: 'document_class_denied', document_class: 'image' }]);
    });

    it('the gate fact budget joins the min: tightest cap wins', async () => {
      await clearGate();
      await tdb.pool.query(
        `INSERT INTO extraction_gate (owner_id, source_type, fact_budget) VALUES ($1, 'user_note', 1)`,
        [OWNER],
      );
      const gateway = new ScriptedGateway(() => ({
        facts: [fact(claim), fact('Ana will also call Marko about the invoice.')],
      }));
      const sourceId = reader.add(`${claim} Ana will also call Marko about the invoice.`);
      const summary = await run(gatedPipeline(gateway), sourceId);
      expect(summary.extracted).toBe(1);
      expect((await memoriesFor(sourceId)).rows).toHaveLength(1);
    });

    it('retention stamps valid_until only on facts with no validity of their own', async () => {
      await clearGate();
      await tdb.pool.query(
        `INSERT INTO extraction_gate (owner_id, source_type, retention_days) VALUES ($1, 'user_note', 30)`,
        [OWNER],
      );
      const own = fact('The maintenance window is fixed until the end of 2030.', {
        temporal: {
          valid_from: null,
          valid_until: '2030-12-31T00:00:00Z',
          anchors_resolved: true,
        },
      });
      const bare = fact(claim);
      const gateway = new ScriptedGateway(() => ({ facts: [bare, own] }));
      const sourceId = reader.add(
        `${claim} The maintenance window is fixed until the end of 2030.`,
      );
      await run(gatedPipeline(gateway), sourceId);

      const rows = await tdb.pool.query<{ content: string; valid_until: Date | null }>(
        `SELECT content, valid_until FROM memory WHERE source_id = $1`,
        [sourceId],
      );
      const bareRow = rows.rows.find((row) => row.content === bare.claim);
      const ownRow = rows.rows.find((row) => row.content === own.claim);
      expect(ownRow?.valid_until?.toISOString()).toBe('2030-12-31T00:00:00.000Z');
      const days = (t: Date) => (t.getTime() - Date.now()) / 86_400_000;
      expect(bareRow?.valid_until).toBeTruthy();
      expect(days(bareRow!.valid_until!)).toBeGreaterThan(29);
      expect(days(bareRow!.valid_until!)).toBeLessThan(31);
    });
  });

  describe('source_context anchoring (V2.1 item 4.2): the anchor call and its injection', () => {
    const fileReader = new FakeFileReader();
    const anchoredPipeline = (gateway: ScriptedGateway) =>
      new IngestionPipeline(
        [fileReader],
        new ExtractStage(gateway),
        new VerifyStage(gateway),
        new EmbedStoreStage(gateway, store, createSuppressedFactLog(tdb.db)),
        new ReconciliationService(gateway, store, new MemoryReconciliation(tdb.db, store)),
        createSuppressedFactLog(tdb.db),
        undefined,
        undefined,
        undefined,
        new AnchorStage(gateway, createSourceContextStore(tdb.db)),
      );
    const runFile = (pipeline: IngestionPipeline, sourceId: string) =>
      tdb.db.transaction((tx) => pipeline.run(tx, { source_type: 'file', source_id: sourceId }));

    it('anchors a document, stores the context, and injects it into extraction', async () => {
      const claim = 'The PWR-3100 has a continuous output of 100 W.';
      const gateway = new ScriptedGateway(() => ({
        facts: [fact(claim, { source_span: 'Continuous output: 100 W.' })],
      }));
      const sourceId = fileReader.add('Model PWR-3100\nContinuous output: 100 W.');
      const summary = await runFile(anchoredPipeline(gateway), sourceId);

      expect(gateway.anchorCalls).toBe(1);
      expect(summary.admitted.active + summary.admitted.uncertain).toBe(1);
      // The extraction input carried the fenced context block.
      expect(gateway.lastExtractInput).toContain('DOCUMENT CONTEXT:');
      expect(gateway.lastExtractInput).toContain('subjects: PWR-3100');
      // The context row was stored with the machine prompt version.
      const rows = await tdb.pool.query<{
        subjects: unknown;
        edited_by_user: boolean;
        prompt_version: string | null;
      }>(
        `SELECT subjects, edited_by_user, prompt_version FROM source_context WHERE source_id = $1`,
        [sourceId],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.edited_by_user).toBe(false);
      expect(rows.rows[0]!.prompt_version).toBe('anchoring/v0001');
      expect(rows.rows[0]!.subjects).toEqual([{ name: 'PWR-3100', confident: true }]);
    });

    it('a user-edited context is authoritative: no anchor call, the edit is injected', async () => {
      const claim = 'The corrected model has a continuous output of 100 W.';
      const gateway = new ScriptedGateway(() => ({
        facts: [fact(claim, { source_span: 'Continuous output: 100 W.' })],
      }));
      const sourceId = fileReader.add('Continuous output: 100 W.');
      await tdb.pool.query(
        `INSERT INTO source_context (owner_id, source_type, source_id, subjects, edited_by_user)
         VALUES ('user-pipeline', 'file', $1, $2::jsonb, true)`,
        [sourceId, JSON.stringify([{ name: 'Corrected AAA', confident: true }])],
      );
      await runFile(anchoredPipeline(gateway), sourceId);

      expect(gateway.anchorCalls).toBe(0);
      expect(gateway.lastExtractInput).toContain('subjects: Corrected AAA');
      // Still marked edited, still the user's row.
      const rows = await tdb.pool.query<{ edited_by_user: boolean; prompt_version: string | null }>(
        `SELECT edited_by_user, prompt_version FROM source_context WHERE source_id = $1`,
        [sourceId],
      );
      expect(rows.rows[0]).toEqual({ edited_by_user: true, prompt_version: null });
    });

    it('a failed anchor call degrades to no context and the run still succeeds', async () => {
      const claim = 'The device has a continuous output of 100 W.';
      const gateway = new ScriptedGateway(() => ({
        facts: [fact(claim, { source_span: 'Continuous output: 100 W.' })],
      }));
      gateway.anchorOutput = () => {
        throw new ModelGatewayError('anchor model down', false);
      };
      const sourceId = fileReader.add('Continuous output: 100 W.');
      const summary = await runFile(anchoredPipeline(gateway), sourceId);

      expect(summary.admitted.active + summary.admitted.uncertain).toBe(1);
      expect(gateway.lastExtractInput).not.toContain('DOCUMENT CONTEXT');
      const rows = await tdb.pool.query(`SELECT id FROM source_context WHERE source_id = $1`, [
        sourceId,
      ]);
      expect(rows.rows).toHaveLength(0);
    });
  });
});
