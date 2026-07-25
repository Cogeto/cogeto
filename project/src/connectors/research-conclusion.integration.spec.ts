import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOnce } from 'graphile-worker';
import type { TaskList } from 'graphile-worker';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import { DailyCounters, idempotentTask } from '../infrastructure/index';
import { fakeEmbedding, settleJobs, startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { createMemoryStore, MemoryReconciliation } from '../memory/index';
import type { MemoryObjectStore, MemoryStore } from '../memory/index';
import { ModelGateway, ModelGatewayError } from '../model-gateway/index';
import type { CompletionResult, StructuredExtractionRequest } from '../model-gateway/index';
import { createIngestionPipeline, INGESTION_PIPELINE_JOB_TYPE } from '../ingestion/index';
import { ConversationScribe } from '../retrieval/index';
import { ResearchService } from './research.service';
import { ResearchSynthesisService } from './research-synthesis.service';
import { ResearchConclusionService, RESEARCH_CONCLUDE_JOB_TYPE } from './research-conclude';
import { WebDiscoveryService } from './web-discovery.service';
import { WebFetchService } from './web-fetch';
import { WebSourceReader } from './web.source-reader';
import type { ResearchOptions } from './research-options';

/**
 * Server-side research conclusion + focused extraction (decision 0057):
 *
 *   research_concludes_server_side — when the last captured page's pipeline
 *     job settles, the conclusion job synthesises and STORES the answer on the
 *     run (status 'concluded', unseen) with no client watching.
 *   resume_replay_marks_seen — asking for the synthesis of a concluded run
 *     replays the STORED answer (no new model call) and marks it seen.
 *   conclusion_idempotent — a duplicate conclusion delivery changes nothing.
 *   focused_extraction — a big page captured under an approved query stores a
 *     query-ranked extraction view (embeddings only) the reader prefers; a
 *     small page stores none and extracts whole.
 */

const DIMS = 8;
const EMBED_MODEL = 'test-embed';

const owner: Principal = {
  userId: 'user-conclude',
  name: 'Conclude Owner',
  email: 'conclude@instance.test',
  orgId: 'org-conclude',
  orgName: 'Org',
  roles: [],
};

const options: ResearchOptions = {
  searxngUrl: 'http://searxng:8080',
  resultCap: 8,
  searchTimeoutMs: 500,
  fetchTimeoutMs: 500,
  fetchMaxBytes: 4 * 1024 * 1024,
  retainHtml: false,
};

const SMALL_PAGE = `<html><head><title>Small — Fees</title></head><body>
<main><p>The harbour day fee is 12 EUR.</p></main></body></html>`;

/** ~48k chars of paragraphs → well past the focus threshold (7+ chunks). */
const BIG_PAGE = `<html><head><title>Big — Regulations</title></head><body><main>${Array.from(
  { length: 240 },
  (_, i) =>
    `<p>Regulation paragraph ${i}: harbour mooring rules section with filler text ${'x'.repeat(150)}.</p>`,
).join('')}<p>The mooring permit costs 40 EUR per season.</p></main></body></html>`;

class ConcludeGateway extends ModelGateway {
  completeCalls = 0;
  async complete(): Promise<CompletionResult> {
    this.completeCalls += 1;
    return { text: 'The harbour day fee is 12 EUR. [W1] Permits cost 40 EUR. [W2] [W9]' };
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
    } else if (request.input.startsWith('CLAIMS UNDER REVIEW')) {
      raw = {
        verdicts: [...request.input.matchAll(/CLAIM (\d+):/g)].map((m) => ({
          claim: Number(m[1]),
          verdict: 'supported',
          reason: 'scripted',
        })),
      };
    } else if (request.input.startsWith('FACT A:')) {
      raw = request.system.includes('same_fact')
        ? { verdict: 'distinct', reason: 'scripted', merged_content: null }
        : { verdict: 'compatible', direction: null, reason: 'scripted' };
    } else {
      const claim = `A fee fact from this page (${request.input.length})`;
      raw = {
        facts: [
          {
            claim,
            kind: 'fact',
            entities: { people: [], organizations: [], projects: [] },
            condition: null,
            temporal: { valid_from: null, valid_until: null, anchors_resolved: true },
            source_span: request.input.slice(-60),
          },
        ],
      };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelGatewayError('scripted output failed schema', false);
    return parsed.data;
  }
}

describe('research conclusion (integration: real Postgres + Qdrant, scripted gateway + web)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;
  let gateway: ConcludeGateway;
  let research: ResearchService;
  let synthesis: ResearchSynthesisService;
  let concluder: ResearchConclusionService;

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    store = createMemoryStore({
      db: tdb.db,
      qdrant: { url: qdrant.url, embeddingModel: EMBED_MODEL, dimensions: DIMS },
    });
    await store.ensureIndexReady();
    gateway = new ConcludeGateway();

    const discovery = new WebDiscoveryService(options);
    discovery.fetchImpl = async () =>
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const fetcher = new WebFetchService(options);
    fetcher.resolveAddresses = async () => ['203.0.113.10'];
    fetcher.fetchImpl = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/robots.txt')) return new Response('nope', { status: 404 });
      const html = url.includes('big') ? BIG_PAGE : SMALL_PAGE;
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const objects = new Proxy(
      {},
      {
        get() {
          throw new Error('unused');
        },
      },
    ) as MemoryObjectStore;
    research = new ResearchService(
      tdb.db,
      discovery,
      fetcher,
      objects,
      new DailyCounters(),
      { searchesMax: 100, pagesMax: 100, pagesPerRunMax: 5 },
      options,
      gateway,
      store,
    );
    // The WORKER composition (decision 0057): no retrieval — web-only answers.
    // The append seam (issue #259) is the real retrieval-owned scribe.
    synthesis = new ResearchSynthesisService(
      research,
      undefined,
      gateway,
      undefined,
      undefined,
      new ConversationScribe(tdb.db),
    );
    concluder = new ResearchConclusionService();
  }, 180_000);

  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  /** The worker's task list, mirroring worker-tasks.ts: the pipeline job with
   * the conclusion trigger, plus the conclusion job itself. */
  const runWorker = async () => {
    const pipeline = createIngestionPipeline({
      readers: [new WebSourceReader(tdb.db)],
      gateway,
      store,
      reconciliation: new MemoryReconciliation(tdb.db, store),
    });
    const taskList: TaskList = {
      [INGESTION_PIPELINE_JOB_TYPE]: idempotentTask(
        tdb.db,
        INGESTION_PIPELINE_JOB_TYPE,
        async (tx, payload) => {
          await pipeline.run(tx, payload);
          if (payload.source_type === 'web') {
            await concluder.afterPageProcessed(tx, payload.source_id);
          }
        },
      ),
      [RESEARCH_CONCLUDE_JOB_TYPE]: async (rawPayload) => {
        const runId = (rawPayload as { source_id?: string }).source_id;
        if (runId) await synthesis.concludeRun(runId);
      },
    };
    await runOnce({ pgPool: tdb.pool, taskList });
    await settleJobs(tdb.pool);
  };

  let runId: string;

  it('research_concludes_server_side: the worker stores the answer once the last page settles — nobody watching — and lands it in the conversation', async () => {
    // The invoking conversation (issue #259): the concluded answer must land
    // here as a persistent assistant message, automatically.
    const conversationId = (
      await tdb.pool.query<{ id: string }>(
        `INSERT INTO conversation (owner_id) VALUES ($1) RETURNING id`,
        [owner.userId],
      )
    ).rows[0]!.id;
    const run = await research.propose(owner, 'harbour fees in Split', conversationId);
    await research.approveAndSearch(owner, run.id, 'harbour fees Split');
    runId = run.id;
    const captured = await research.capture(
      owner,
      ['https://harbour.example.org/small', 'https://harbour.example.org/big-regulations'],
      'private',
      runId,
    );
    expect(captured.every((r) => r.status === 'captured')).toBe(true);

    // First pass: the two pipeline jobs run; the LAST one enqueues conclusion.
    await runWorker();
    // Second pass: the conclusion job synthesises and stores.
    await runWorker();

    const concluded = await research.getRun(owner, runId);
    expect(concluded!.status).toBe('concluded');
    expect(concluded!.concludedAt).not.toBeNull();
    expect(concluded!.answer).toContain('12 EUR');
    expect(concluded!.answer).toContain('[W1]');
    expect(concluded!.answer).not.toContain('[W9]'); // invented marker stripped
    expect(gateway.completeCalls).toBe(1);
    // Delivered into the thread (issue #259): a persistent assistant message
    // with numbered web references + a Sources block — and that counts as
    // seen, so the run never haunts the resume surface.
    expect(concluded!.answerSeenAt).not.toBeNull();
    const appended = await tdb.pool.query<{ role: string; content: string }>(
      `SELECT role, content FROM chat_message WHERE conversation_id = $1`,
      [concluded!.conversationId],
    );
    expect(appended.rows).toHaveLength(1);
    expect(appended.rows[0]!.role).toBe('assistant');
    expect(appended.rows[0]!.content).toContain('12 EUR');
    expect(appended.rows[0]!.content).toContain('[1]');
    expect(appended.rows[0]!.content).toContain('Sources:');
    expect(appended.rows[0]!.content).toContain('harbour.example.org');
    expect(appended.rows[0]!.content).not.toContain('[W1]'); // thread form only
  });

  it('conversationless runs conclude without appending and stay unseen (Research page owns them)', async () => {
    const run = await research.propose(owner, 'standalone harbour question');
    await research.approveAndSearch(owner, run.id, 'standalone harbour question');
    const captured = await research.capture(
      owner,
      ['https://harbour.example.org/small-standalone'],
      'private',
      run.id,
    );
    expect(captured[0]).toMatchObject({ status: 'captured' });
    await runWorker();
    await runWorker();
    const concluded = await research.getRun(owner, run.id);
    expect(concluded!.status).toBe('concluded');
    expect(concluded!.answerSeenAt).toBeNull(); // nobody watching, nowhere to land
    const messages = await tdb.pool.query(`SELECT 1 FROM chat_message`);
    expect(messages.rows).toHaveLength(1); // only the first test's appended answer
  });

  it('resume_replay_marks_seen: synthesise on a concluded run replays the stored answer without a model call', async () => {
    const callsBefore = gateway.completeCalls;
    const replay = await synthesis.synthesise(owner, runId);
    expect(replay.answer).toContain('12 EUR');
    expect(replay.citations.some((c) => c.kind === 'web')).toBe(true);
    expect(gateway.completeCalls).toBe(callsBefore); // stored, not regenerated
    const seen = await research.getRun(owner, runId);
    expect(seen!.answerSeenAt).not.toBeNull();
  });

  it('conclusion_idempotent: a duplicate conclusion delivery changes nothing', async () => {
    const before = await research.getRun(owner, runId);
    const again = await synthesis.concludeRun(runId);
    expect(again.concluded).toBe(false);
    const after = await research.getRun(owner, runId);
    expect(after!.answer).toBe(before!.answer);
    expect(after!.concludedAt?.toISOString()).toBe(before!.concludedAt?.toISOString());
  });

  it('focused_extraction: a big page stores a query-ranked extraction view the reader prefers; a small page extracts whole', async () => {
    const pages = await tdb.pool.query<{
      id: string;
      final_url: string;
      retained: number;
      extraction: string | null;
    }>(
      `SELECT id, final_url, length(retained_text) AS retained, extraction_text AS extraction
       FROM web_page WHERE research_run_id = $1 ORDER BY length(retained_text)`,
      [runId],
    );
    expect(pages.rows).toHaveLength(2);
    const [small, big] = pages.rows;

    // Small page: focusing declined — extract from the whole retained text.
    expect(small!.extraction).toBeNull();
    // Big page: a focused view exists and is a strict subset of the page.
    expect(big!.extraction).not.toBeNull();
    expect(big!.extraction!.length).toBeLessThan(big!.retained);
    expect(big!.extraction!.length).toBeGreaterThan(0);

    // The reader hands the FOCUSED view to extraction (title-prefixed).
    const reader = new WebSourceReader(tdb.db);
    const item = await reader.load(big!.id);
    expect(item!.content).toContain(big!.extraction!.slice(0, 80));
    expect(item!.content.length).toBeLessThan(big!.retained);
  });
});
