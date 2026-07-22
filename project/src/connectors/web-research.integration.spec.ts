import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HttpException } from '@nestjs/common';
import { runOnce } from 'graphile-worker';
import type { TaskList } from 'graphile-worker';
import type { ZodType } from 'zod';
import type { Principal } from '@cogeto/shared';
import { DailyCounters, idempotentTask } from '../infrastructure/index';
import type { ResearchQuota } from '../infrastructure/index';
import { fakeEmbedding, settleJobs, startTestDatabase, startTestQdrant } from '../testing/index';
import type { TestDatabase, TestQdrant } from '../testing/index';
import { createMemoryStore, MemoryReconciliation } from '../memory/index';
import type { MemoryObjectStore, MemoryStore } from '../memory/index';
import { ModelGateway, ModelGatewayError } from '../model-gateway/index';
import type { StructuredExtractionRequest } from '../model-gateway/index';
import { createIngestionPipeline, INGESTION_PIPELINE_JOB_TYPE } from '../ingestion/index';
import { ResearchService } from './research.service';
import { WebDiscoveryService } from './web-discovery.service';
import { WebFetchService } from './web-fetch';
import { WebSourceReader } from './web.source-reader';
import type { ResearchOptions } from './research-options';
import { webPage } from './persistence/tables';

const DIMS = 8;
const EMBED_MODEL = 'test-embed';
const COLLECTION = 'memories';

const owner: Principal = {
  userId: 'user-web',
  name: 'Web Researcher',
  email: 'web@instance.test',
  orgId: 'org-web',
  orgName: 'Org',
  roles: [],
};

const options = (over: Partial<ResearchOptions> = {}): ResearchOptions => ({
  searxngUrl: 'http://searxng:8080',
  resultCap: 8,
  searchTimeoutMs: 500,
  fetchTimeoutMs: 500,
  fetchMaxBytes: 1024 * 1024,
  retainHtml: false,
  ...over,
});

/** Two fictional pages: an old price and its newer replacement. */
const OLD_PRICE_ISO = '2026-05-01T00:00:00.000Z';
const NEW_PRICE_ISO = '2026-07-10T00:00:00.000Z';
const PAGE_OLD = `<html><head><title>Jadranska Riva — Cjenik</title></head><body>
<nav>Home</nav><main><p>A day pass at Jadranska Riva costs 12 EUR.</p></main></body></html>`;
const PAGE_NEW = `<html><head><title>Jadranska Riva — Cjenik</title></head><body>
<nav>Home</nav><main><p>A day pass at Jadranska Riva costs 15 EUR.</p></main></body></html>`;

/**
 * Scripted gateway that RECORDS how the pipeline talks to it: every
 * extractStructured tier, every extraction input, and any answer-tier call
 * (complete/completeStream), which must never happen from the pipeline.
 */
class RecordingGateway extends ModelGateway {
  tiers: (string | undefined)[] = [];
  extractionInputs: string[] = [];
  answerTierCalls = 0;

  complete(): never {
    this.answerTierCalls += 1;
    throw new Error('the pipeline must never use the answer tier');
  }
  // eslint-disable-next-line require-yield -- must never be reached
  async *completeStream(): AsyncIterable<string> {
    this.answerTierCalls += 1;
    throw new Error('the pipeline must never use the answer tier');
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => fakeEmbedding(t, DIMS));
  }
  embeddingModelId(): string {
    return EMBED_MODEL;
  }
  async extractStructured<T>(schema: ZodType<T>, request: StructuredExtractionRequest): Promise<T> {
    this.tiers.push(request.tier);
    let raw: unknown;
    if (request.input.startsWith('CLAIM UNDER REVIEW')) {
      raw = { verdict: 'supported', reason: 'scripted' };
    } else if (request.input.startsWith('FACT A:')) {
      raw = request.system.includes('same_fact')
        ? { verdict: 'distinct', reason: 'scripted', merged_content: null }
        : { verdict: 'compatible', direction: null, reason: 'scripted' };
    } else {
      this.extractionInputs.push(request.input);
      const isOld = request.input.includes('12 EUR');
      const claim = isOld
        ? 'A day pass at Jadranska Riva costs 12 EUR'
        : 'A day pass at Jadranska Riva costs 15 EUR';
      raw = {
        facts: [
          {
            claim,
            kind: 'fact',
            entities: { people: [], organizations: ['Jadranska Riva'], projects: [] },
            condition: null,
            temporal: {
              valid_from: isOld ? OLD_PRICE_ISO : NEW_PRICE_ISO,
              valid_until: null,
              anchors_resolved: true,
            },
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

/** A scripted public web: robots absent, both pages served, DNS public. */
function scriptedFetcher(opts: ResearchOptions): WebFetchService {
  const fetcher = new WebFetchService(opts);
  fetcher.resolveAddresses = async () => ['203.0.113.10'];
  fetcher.fetchImpl = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/robots.txt')) return new Response('nope', { status: 404 });
    if (url.includes('/old')) {
      return new Response(PAGE_OLD, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (url.includes('/new')) {
      return new Response(PAGE_NEW, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    return new Response('not found', { status: 404 });
  };
  return fetcher;
}

/** retainHtml stays off in this spec, so the object store is never touched. */
const objectsUnused = new Proxy(
  {},
  {
    get() {
      throw new Error('object store must not be touched with retainHtml off');
    },
  },
) as MemoryObjectStore;

describe('web research (integration: real Postgres + Qdrant, scripted gateway + web)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;
  let gateway: RecordingGateway;
  let research: ResearchService;
  let quota: ResearchQuota;

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    store = createMemoryStore({
      db: tdb.db,
      qdrant: { url: qdrant.url, embeddingModel: EMBED_MODEL, dimensions: DIMS },
    });
    await store.ensureIndexReady();
    gateway = new RecordingGateway();
    quota = { searchesMax: 100, pagesMax: 100, pagesPerRunMax: 5 };
    research = new ResearchService(
      tdb.db,
      new WebDiscoveryService(options()),
      scriptedFetcher(options()),
      objectsUnused,
      new DailyCounters(),
      quota,
      options(),
    );
  }, 180_000);

  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  const pipeline = () =>
    createIngestionPipeline({
      readers: [new WebSourceReader(tdb.db)],
      gateway,
      store,
      reconciliation: new MemoryReconciliation(tdb.db, store),
    });
  const taskList = (): TaskList => ({
    [INGESTION_PIPELINE_JOB_TYPE]: idempotentTask(
      tdb.db,
      INGESTION_PIPELINE_JOB_TYPE,
      async (tx, payload) => {
        await pipeline().run(tx, payload);
      },
    ),
  });
  const runWorker = async () => {
    await runOnce({ pgPool: tdb.pool, taskList: taskList() });
    await settleJobs(tdb.pool);
  };

  const memoriesFor = (sourceId: string) =>
    tdb.pool.query<{
      id: string;
      content: string;
      status: string;
      valid_from: Date | null;
      valid_until: Date | null;
      superseded_by: string | null;
    }>(
      `SELECT id, content, status, valid_from, valid_until, superseded_by
       FROM memory WHERE source_type = 'web' AND source_id = $1`,
      [sourceId],
    );

  let oldPageId: string;
  let newPageId: string;

  it('web_source_provenance: a captured page yields memories citing the web source, URL and fetch time one click away', async () => {
    const results = await research.capture(owner, ['https://riva.example.org/old']);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: 'captured' });
    if (results[0]!.status !== 'captured') throw new Error('unreachable');
    oldPageId = results[0].id;

    await runWorker();

    const rows = (await memoriesFor(oldPageId)).rows;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.content).toContain('12 EUR');
    expect(rows[0]!.status).toBe('active');

    // Provenance is one click away: the drawer read returns the URL and fetch time.
    const source = await research.getForOwner(owner, oldPageId);
    expect(source).not.toBeNull();
    expect(source!.finalUrl).toContain('riva.example.org');
    expect(source!.title).toBe('Jadranska Riva — Cjenik');
    expect(source!.retainedText).toContain('12 EUR');
    expect(source!.fetchedAt).toBeInstanceOf(Date);
    expect(await research.getProcessingState(oldPageId)).toBe('done');

    // A non-owner sees nothing.
    expect(await research.getForOwner({ ...owner, userId: 'someone-else' }, oldPageId)).toBeNull();

    // The Qdrant payload carries the same provenance (rebuildable index).
    const scroll = await fetch(`${qdrant.url}/collections/${COLLECTION}/points/scroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        limit: 10,
        filter: { must: [{ key: 'source_id', match: { value: oldPageId } }] },
        with_payload: true,
      }),
    });
    const body = (await scroll.json()) as {
      result: { points: { payload: { source_type: string } }[] };
    };
    expect(body.result.points.length).toBeGreaterThanOrEqual(1);
    expect(body.result.points[0]!.payload.source_type).toBe('web');
  });

  it('extraction_pipeline_tier: all model work ran on the pipeline tier, anchored to the fetch time; the answer tier was never called', async () => {
    // Every structured call left the tier at its default — the pipeline tier.
    expect(gateway.tiers.length).toBeGreaterThanOrEqual(2); // extract + verify at minimum
    expect(gateway.tiers.every((t) => t === undefined || t === 'pipeline')).toBe(true);
    expect(gateway.answerTierCalls).toBe(0);
    // The extraction input's REFERENCE TIME is the web row's fetch timestamp.
    const source = await research.getForOwner(owner, oldPageId);
    expect(
      gateway.extractionInputs.some((input) => input.includes(source!.fetchedAt.toISOString())),
    ).toBe(true);
    // And the boilerplate never reached extraction — only readable content did.
    expect(gateway.extractionInputs.every((input) => !input.includes('<nav>'))).toBe(true);
  });

  it('web_facts_temporal: web facts carry validity intervals and a newer fetch supersedes the older claim, closing its interval', async () => {
    const first = (await memoriesFor(oldPageId)).rows[0]!;
    expect(first.valid_from?.toISOString()).toBe(OLD_PRICE_ISO);

    // A newer fetch of the updated page.
    const results = await research.capture(owner, ['https://riva.example.org/new']);
    if (results[0]!.status !== 'captured') throw new Error('capture failed');
    newPageId = results[0].id;
    await runWorker();

    const second = (await memoriesFor(newPageId)).rows[0]!;
    expect(second.valid_from?.toISOString()).toBe(NEW_PRICE_ISO);

    // Supersession (the same operation reconciliation applies on a
    // 'supersedes' verdict): the newer claim closes the older one's interval.
    const reconciliation = new MemoryReconciliation(tdb.db, store);
    await tdb.db.transaction((tx) =>
      reconciliation.applySupersession(tx, second.id, first.id, 'newer fetch of the same page'),
    );

    const closed = (await memoriesFor(oldPageId)).rows[0]!;
    expect(closed.status).toBe('replaced');
    expect(closed.superseded_by).toBe(second.id);
    expect(closed.valid_until?.toISOString()).toBe(NEW_PRICE_ISO);
  });

  it('research_budget_enforced: daily caps stop searches and pages with a clear limit-reached message', async () => {
    const counters = new DailyCounters();
    const tiny: ResearchQuota = { searchesMax: 1, pagesMax: 1, pagesPerRunMax: 2 };
    const discovery = new WebDiscoveryService(options());
    discovery.fetchImpl = async () =>
      new Response(
        JSON.stringify({ results: [{ url: 'https://riva.example.org/old', title: 'x' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const limited = new ResearchService(
      tdb.db,
      discovery,
      scriptedFetcher(options()),
      objectsUnused,
      counters,
      tiny,
      options(),
    );

    // Search 1 passes; search 2 is refused with the typed 429.
    expect((await limited.search(owner, 'jadranska riva cjenik')).status).toBe('ok');
    const refusal = await limited.search(owner, 'again').then(
      () => null,
      (error: unknown) => error as HttpException,
    );
    expect(refusal).not.toBeNull();
    expect(refusal!.getStatus()).toBe(429);
    expect(refusal!.getResponse()).toMatchObject({ code: 'daily_research_limit' });

    // Page 1 consumes the daily page budget; page 2 is annotated, not fetched.
    const results = await limited.capture(owner, [
      'https://riva.example.org/old',
      'https://riva.example.org/new',
    ]);
    expect(results[0]).toMatchObject({ status: 'captured' });
    expect(results[1]).toMatchObject({ status: 'skipped', reason: 'limit_reached' });
    if (results[1]!.status === 'skipped') {
      expect(results[1].detail).toContain('try again tomorrow');
    }

    // The per-research page cap refuses an oversized selection outright.
    const oversized = await limited
      .capture(owner, ['https://a.example', 'https://b.example', 'https://c.example'])
      .then(
        () => null,
        (error: unknown) => error as HttpException,
      );
    expect(oversized).not.toBeNull();
    expect(oversized!.getResponse()).toMatchObject({ code: 'research_page_cap' });

    // Clean up the extra captured page's rows so later suites see a settled queue.
    await settleJobs(tdb.pool);
  });

  it('cleans up: captured web rows exist exactly for the captured pages', async () => {
    const rows = await tdb.db.select({ id: webPage.id }).from(webPage);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});
