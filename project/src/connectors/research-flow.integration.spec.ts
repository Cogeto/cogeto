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
import type { RetrievalService } from '../retrieval/index';
import { ResearchService } from './research.service';
import { ResearchSynthesisService } from './research-synthesis.service';
import { WebDiscoveryService } from './web-discovery.service';
import { WebFetchService } from './web-fetch';
import { WebSourceReader } from './web.source-reader';
import type { ResearchOptions } from './research-options';

const DIMS = 8;
const EMBED_MODEL = 'test-embed';

const owner: Principal = {
  userId: 'user-flow',
  name: 'Flow Owner',
  email: 'flow@instance.test',
  orgId: 'org-flow',
  orgName: 'Org',
  roles: [],
};

const options: ResearchOptions = {
  searxngUrl: 'http://searxng:8080',
  resultCap: 8,
  searchTimeoutMs: 500,
  fetchTimeoutMs: 500,
  fetchMaxBytes: 1024 * 1024,
  retainHtml: false,
};

const PAGE = `<html><head><title>Jadranska Riva — Cjenik</title></head><body>
<main><p>A day pass at Jadranska Riva costs 15 EUR.</p></main></body></html>`;

/** One scripted gateway for every stage the flow touches. */
class FlowGateway extends ModelGateway {
  /** The cited synthesis the answer tier "writes" — includes an invented [W9]. */
  answerText =
    'A day pass costs 15 EUR. [W1] You already noted the venue. [M1] ' +
    'Prices in the area have been rising. (unsourced) [W9]';
  completeCalls = 0;

  async complete(): Promise<CompletionResult> {
    this.completeCalls += 1;
    return { text: this.answerText };
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
    if (request.input.startsWith('RESEARCH INTENT:')) {
      raw = {
        minimised_query: 'coworking day pass prices Split',
        removed: [],
        kept: [],
        reason: 'nothing identifying was present',
      };
    } else if (request.input.startsWith('CLAIM UNDER REVIEW')) {
      raw = { verdict: 'supported', reason: 'scripted' };
    } else if (request.input.startsWith('FACT A:')) {
      raw = request.system.includes('same_fact')
        ? { verdict: 'distinct', reason: 'scripted', merged_content: null }
        : { verdict: 'compatible', direction: null, reason: 'scripted' };
    } else {
      const claim = 'A day pass at Jadranska Riva costs 15 EUR';
      raw = {
        facts: [
          {
            claim,
            kind: 'fact',
            entities: { people: [], organizations: ['Jadranska Riva'], projects: [] },
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

describe('research flow (integration: real Postgres + Qdrant, scripted gateway + web)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;
  let gateway: FlowGateway;
  let research: ResearchService;

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    store = createMemoryStore({
      db: tdb.db,
      qdrant: { url: qdrant.url, embeddingModel: EMBED_MODEL, dimensions: DIMS },
    });
    await store.ensureIndexReady();
    gateway = new FlowGateway();

    const discovery = new WebDiscoveryService(options);
    discovery.fetchImpl = async () =>
      new Response(
        JSON.stringify({
          results: [{ url: 'https://riva.example.org/cjenik', title: 'Cjenik', content: 'prices' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const fetcher = new WebFetchService(options);
    fetcher.resolveAddresses = async () => ['203.0.113.10'];
    fetcher.fetchImpl = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/robots.txt')) return new Response('nope', { status: 404 });
      return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
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
    );
  }, 180_000);

  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

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
        },
      ),
    };
    await runOnce({ pgPool: tdb.pool, taskList });
    await settleJobs(tdb.pool);
  };

  let runId: string;
  let pageId: string;

  it('research_creates_memories + sent_query_in_provenance: the approved query is on every derived memory’s provenance chain', async () => {
    const run = await research.propose(owner, 'coworking day pass prices in Split');
    const sent = 'coworking day pass prices Split 2026';
    const { search } = await research.approveAndSearch(owner, run.id, sent);
    expect(search.status).toBe('ok');
    runId = run.id;

    const captured = await research.capture(
      owner,
      ['https://riva.example.org/cjenik'],
      'private',
      runId,
    );
    expect(captured[0]).toMatchObject({ status: 'captured' });
    pageId = captured[0]!.status === 'captured' ? captured[0].id : '';

    await runWorker();

    // Durable web memories exist for reuse (the next question needs no search).
    const memories = await tdb.pool.query<{ id: string; content: string }>(
      `SELECT id, content FROM memory WHERE source_type = 'web' AND source_id = $1`,
      [pageId],
    );
    expect(memories.rows.length).toBeGreaterThanOrEqual(1);
    expect(memories.rows[0]!.content).toContain('15 EUR');

    // The provenance chain: memory → web_page → research_run.sent_query.
    const page = await research.getForOwner(owner, pageId);
    expect(page!.researchRunId).toBe(runId);
    expect(await research.sentQueryFor(page!)).toBe(sent);
  });

  it('research_answer_cited: every web claim carries a URL + fetch-time citation; unknown markers are stripped; the memory claim cites a memory', async () => {
    // Retrieval stubbed to one deterministic remembered fact ([M1]).
    const retrieval = {
      retrieve: async () => ({
        memories: [
          {
            memory: {
              id: 'a1b2c3d4-0000-4000-8000-000000000001',
              content: 'The user tracks Split venues',
              status: 'active',
            },
          },
        ],
        mode: 'default',
      }),
    } as unknown as RetrievalService;
    const synthesis = new ResearchSynthesisService(research, retrieval, gateway);

    const result = await synthesis.synthesise(owner, runId);
    expect(gateway.completeCalls).toBe(1); // the answer tier, exactly once

    // The web claim cites its page with URL and fetch time.
    const web = result.citations.find((c) => c.kind === 'web');
    expect(web).toBeTruthy();
    if (web?.kind === 'web') {
      expect(web.marker).toBe('[W1]');
      expect(web.url).toContain('riva.example.org');
      expect(new Date(web.fetchedAt).getTime()).toBeGreaterThan(0);
      expect(web.webPageId).toBe(pageId);
    }
    // The memory claim cites the memory; model knowledge stays marked.
    const memoryCite = result.citations.find((c) => c.kind === 'memory');
    expect(memoryCite).toMatchObject({ marker: '[M1]' });
    expect(result.answer).toContain('(unsourced)');
    // The invented [W9] never survives into the record.
    expect(result.answer).not.toContain('[W9]');

    // The answer is durable on the run.
    const persisted = await research.getRun(owner, runId);
    expect(persisted!.answer).toBe(result.answer);
  });

  it('synthesis refuses an unapproved or pageless run', async () => {
    const fresh = await research.propose(owner, 'something else');
    const retrieval = { retrieve: async () => ({ memories: [], mode: 'default' }) };
    const synthesis = new ResearchSynthesisService(
      research,
      retrieval as unknown as RetrievalService,
      gateway,
    );
    await expect(synthesis.synthesise(owner, fresh.id)).rejects.toMatchObject({ status: 422 });
  });
});
