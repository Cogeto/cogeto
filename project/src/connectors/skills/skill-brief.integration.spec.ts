import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOnce } from 'graphile-worker';
import type { TaskList } from 'graphile-worker';
import type { ZodType } from 'zod';
import type { Principal, ResearchCitationDto, SkillStepLinks } from '@cogeto/shared';
import { DailyCounters, EMPTY_USER_CONTEXT, idempotentTask } from '../../infrastructure/index';
import type { ResearchQuota, UserContextService } from '../../infrastructure/index';
import { fakeEmbedding, settleJobs, startTestDatabase, startTestQdrant } from '../../testing/index';
import type { TestDatabase, TestQdrant } from '../../testing/index';
import { createMemoryStore, MemoryReconciliation } from '../../memory/index';
import type { MemoryObjectStore, MemoryStore } from '../../memory/index';
import { ModelGateway, ModelGatewayError } from '../../model-gateway/index';
import type {
  CompletionRequest,
  CompletionResult,
  StructuredExtractionRequest,
} from '../../model-gateway/index';
import { createIngestionPipeline, INGESTION_PIPELINE_JOB_TYPE } from '../../ingestion/index';
import type { RetrievalService } from '../../retrieval/index';
import { ResearchService } from '../research.service';
import { ResearchConclusionService } from '../research-conclude';
import { WebDiscoveryService } from '../web-discovery.service';
import { WebFetchService } from '../web-fetch';
import { WebSourceReader } from '../web.source-reader';
import type { ResearchOptions } from '../research-options';
import { SkillEngine } from './skill-engine';
import { SkillPlanner } from './skill-planner';
import { SKILL_ADVANCE_JOB_TYPE, SkillRunService } from './skill-run.service';

/**
 * The research-brief skill's brief (issue #262): memory integration, web
 * citation with URL + fetch time, contradiction surfacing, and the anchor
 * language — against real Postgres + Qdrant with a scripted gateway.
 */

const DIMS = 8;
const EMBED_MODEL = 'test-embed';

const owner: Principal = {
  userId: 'user-brief',
  name: 'Brief Owner',
  email: 'brief@instance.test',
  orgId: 'org-brief',
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

const quota: ResearchQuota = {
  searchesMax: 100,
  pagesMax: 100,
  pagesPerRunMax: 5,
  skillQueriesMax: 6,
  skillPagesPerQuery: 1,
};

const PAGE = `<html><head><title>Adriatic Foods</title></head><body>
<main><p>Adriatic Foods employs two hundred people as of 2026.</p></main></body></html>`;
const WEB_CLAIM = 'Adriatic Foods employs two hundred people as of 2026';

class BriefGateway extends ModelGateway {
  lastBriefInput = '';
  briefText =
    '### Who they are\nA Split-based distributor. [W1]\n' +
    '### What you already know\nYou agreed 30-day payment terms. [M1] ' +
    'Your note says they have 20 employees. [M2]\n' +
    '### What is new or changed\nThe site says two hundred employees, as of 2026. [W1]\n' +
    '### Contradictions and open questions\nYour notes say 20 employees [M2]; ' +
    'the site says two hundred [W1] — worth confirming in the meeting.\n' +
    '### Talking points\nConfirm the current headcount. [W1]';

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.lastBriefInput = request.input;
    return { text: this.briefText };
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
    if (request.input.startsWith('SUBJECT:')) {
      raw = {
        queries: [
          { query: 'Adriatic Foods', angle: 'identity', reason: 'the subject is the point' },
        ],
      };
    } else if (request.input.startsWith('CLAIMS UNDER REVIEW')) {
      raw = {
        verdicts: [...request.input.matchAll(/CLAIM (\d+):/g)].map((m) => ({
          claim: Number(m[1]),
          verdict: 'supported',
          reason: 'scripted',
        })),
      };
    } else if (request.input.startsWith('CLAIM UNDER REVIEW')) {
      raw = { verdict: 'supported', reason: 'scripted' };
    } else if (request.input.startsWith('FACT A:')) {
      raw = request.system.includes('same_fact')
        ? { verdict: 'distinct', reason: 'scripted', merged_content: null }
        : { verdict: 'compatible', direction: null, reason: 'scripted' };
    } else {
      raw = {
        facts: [
          {
            claim: WEB_CLAIM,
            kind: 'fact',
            entities: { people: [], organizations: ['Adriatic Foods'], projects: [] },
            condition: null,
            temporal: { valid_from: null, valid_until: null, anchors_resolved: true },
            source_span: WEB_CLAIM,
          },
        ],
      };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelGatewayError('scripted output failed schema', false);
    return parsed.data;
  }
}

describe('research-brief skill: the brief (integration)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;
  let gateway: BriefGateway;
  let research: ResearchService;
  let runs: SkillRunService;
  let engine: SkillEngine;
  let planner: SkillPlanner;
  let termsMemoryId: string;
  let headcountMemoryId: string;
  let runId: string;

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    store = createMemoryStore({
      db: tdb.db,
      qdrant: { url: qdrant.url, embeddingModel: EMBED_MODEL, dimensions: DIMS },
    });
    await store.ensureIndexReady();
    gateway = new BriefGateway();

    const discovery = new WebDiscoveryService(options);
    discovery.fetchImpl = async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              url: 'https://adriaticfoods.example.org/about',
              title: 'About',
              content: '',
              score: 5,
            },
          ],
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
      quota,
      options,
      gateway,
      store,
    );
    runs = new SkillRunService(tdb.db);
    // The user's language anchor is hr (decision 0052): the brief is
    // Cogeto-initiated, so it must speak Croatian whatever the scaffolding.
    const userContext = {
      get: async () => ({ ...EMPTY_USER_CONTEXT, preferredLanguage: 'hr' as const }),
    } as unknown as UserContextService;
    engine = new SkillEngine(tdb.db, runs, research, gateway, store, quota, userContext);

    // Seed the profile: agreed terms (active) + a headcount note the web will
    // contradict — reconciliation's verdict simulated as the stored status.
    const seed = async (content: string, status: string): Promise<string> =>
      (
        await tdb.pool.query<{ id: string }>(
          `INSERT INTO memory
             (owner_id, scope, source_type, source_id, status, content, entities, subject_entity, kind)
           VALUES ($1, 'private', 'user_note', gen_random_uuid()::text, $2, $3,
                   '{"Adriatic Foods"}', 'Adriatic Foods', 'fact')
           RETURNING id`,
          [owner.userId, status, content],
        )
      ).rows[0]!.id;
    termsMemoryId = await seed('Agreed 30-day payment terms with Adriatic Foods', 'active');
    headcountMemoryId = await seed('Adriatic Foods has 20 employees', 'contradicted');

    const retrieval = {
      retrieve: async (_p: unknown, _q: unknown, opts: { rewrite?: { openLoops?: unknown } }) => {
        if ((opts.rewrite as { openLoops: unknown }).openLoops) {
          return { memories: [], mode: 'open_loops', openLoops: [] };
        }
        return {
          memories: [
            {
              memory: {
                id: termsMemoryId,
                entities: ['Adriatic Foods'],
                subjectEntity: 'Adriatic Foods',
                content: 'Agreed 30-day payment terms with Adriatic Foods',
                status: 'active',
              },
            },
            {
              memory: {
                id: headcountMemoryId,
                entities: ['Adriatic Foods'],
                subjectEntity: 'Adriatic Foods',
                content: 'Adriatic Foods has 20 employees',
                status: 'contradicted',
              },
            },
          ],
          mode: 'entity_profile',
        };
      },
    } as unknown as RetrievalService;
    planner = new SkillPlanner(retrieval, research, runs, gateway);

    // The full run, worker included.
    const proposal = await planner.propose(owner, 'research_brief', 'Adriatic Foods');
    if (proposal.status !== 'created') throw new Error('expected a run');
    runId = proposal.run.id;
    const plan = await research.runsForSkill(runId);
    await engine.approvePlan(
      owner,
      runId,
      plan.map((r) => ({ researchRunId: r.id, query: r.minimisedQuery })),
    );
    const pipeline = createIngestionPipeline({
      readers: [new WebSourceReader(tdb.db)],
      gateway,
      store,
      reconciliation: new MemoryReconciliation(tdb.db, store),
    });
    const concluder = new ResearchConclusionService();
    const taskList: TaskList = {
      [INGESTION_PIPELINE_JOB_TYPE]: idempotentTask(
        tdb.db,
        INGESTION_PIPELINE_JOB_TYPE,
        async (tx, payload) => {
          await pipeline.run(tx, payload);
          if (payload.source_type === 'web')
            await concluder.afterPageProcessed(tx, payload.source_id);
        },
      ),
      [SKILL_ADVANCE_JOB_TYPE]: async (rawPayload) => {
        const id = (rawPayload as { source_id?: string }).source_id;
        if (id) await engine.advance(id);
      },
    };
    await runOnce({ pgPool: tdb.pool, taskList });
    await settleJobs(tdb.pool);
  }, 180_000);

  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  it('brief_integrates_memory: the "what you know" claims cite the seeded memories', async () => {
    const run = await runs.getRun(owner, runId);
    expect(run!.status).toBe('completed');
    expect(gateway.lastBriefInput).toContain('WHAT MEMORY KNOWS');
    expect(gateway.lastBriefInput).toContain('Agreed 30-day payment terms');
    const citations = run!.briefCitations as ResearchCitationDto[];
    const memoryIds = citations.filter((c) => c.kind === 'memory').map((c) => c.memoryId);
    expect(memoryIds).toContain(termsMemoryId);
    expect(memoryIds).toContain(headcountMemoryId);
  });

  it('brief_cites_web: new facts cite the page with URL and fetch time', async () => {
    const run = await runs.getRun(owner, runId);
    const web = (run!.briefCitations as ResearchCitationDto[]).find((c) => c.kind === 'web');
    expect(web).toBeTruthy();
    if (web?.kind === 'web') {
      expect(web.url).toContain('adriaticfoods.example.org');
      expect(new Date(web.fetchedAt).getTime()).toBeGreaterThan(0);
    }
  });

  it('contradiction_surfaced: the verify step reports it, the brief input carries it, the brief states the tension', async () => {
    const log = await runs.steps(runId);
    const verify = log.find((s) => s.stepKey === 'verify')!;
    expect(verify.status).toBe('completed');
    expect((verify.links as SkillStepLinks).counts!.contradicted).toBeGreaterThanOrEqual(1);
    expect((verify.links as SkillStepLinks).memoryIds).toContain(headcountMemoryId);
    expect(verify.outputsSummary).toContain('contradicted');
    // The synthesis input names the disputed record; the stored brief states
    // the tension in its own section, never silently preferring a side.
    expect(gateway.lastBriefInput).toContain('CONTRADICTIONS:');
    expect(gateway.lastBriefInput).toContain('Adriatic Foods has 20 employees');
    const run = await runs.getRun(owner, runId);
    expect(run!.brief).toContain('Contradictions and open questions');
  });

  it('the brief speaks the anchor language (decision 0052): the LANGUAGE line is forced strict', async () => {
    expect(gateway.lastBriefInput).toContain(
      'LANGUAGE: always answer in Croatian, whatever language',
    );
  });

  it('the web memories persist beyond the run — the next question needs no re-run', async () => {
    const persisted = await tdb.pool.query(
      `SELECT content FROM memory WHERE owner_id = $1 AND source_type = 'web'`,
      [owner.userId],
    );
    expect(persisted.rows.length).toBeGreaterThanOrEqual(1);
    expect(String(persisted.rows[0]!.content)).toContain('two hundred');
  });
});
