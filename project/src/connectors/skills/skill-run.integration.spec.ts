import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOnce } from 'graphile-worker';
import type { TaskList } from 'graphile-worker';
import type { ZodType } from 'zod';
import type { Principal, SkillStepLinks } from '@cogeto/shared';
import { DailyCounters, idempotentTask } from '../../infrastructure/index';
import type { ResearchQuota } from '../../infrastructure/index';
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
 * The skill runtime (decision 0059), end to end against real Postgres + Qdrant
 * with a scripted gateway and scripted web: run_lifecycle, gate_preserved,
 * creates_nothing, run_resumable, budget_caps_run.
 */

const DIMS = 8;
const EMBED_MODEL = 'test-embed';

const owner: Principal = {
  userId: 'user-skill',
  name: 'Skill Owner',
  email: 'skill@instance.test',
  orgId: 'org-skill',
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
  skillPagesPerQuery: 2,
};

const PAGE_PROFILE = `<html><head><title>Adriatic Foods</title></head><body>
<main><p>Adriatic Foods is a wholesale food distributor based in Split.</p>
<p>Suppliers must submit the RC-1 compliance form by 1 September.</p></main></body></html>`;

const PAGE_NEWS = `<html><head><title>Adriatic Foods News</title></head><body>
<main><p>Adriatic Foods opened a new warehouse in Zadar in July 2026.</p></main></body></html>`;

const PROFILE_CLAIM = 'Adriatic Foods is a wholesale food distributor based in Split';
const OBLIGATION_CLAIM = 'Suppliers must submit the RC-1 compliance form by 1 September';
const NEWS_CLAIM = 'Adriatic Foods opened a new warehouse in Zadar in July 2026';

/** Scripted gateway for every stage a skill run touches. */
class SkillGateway extends ModelGateway {
  completeCalls = 0;
  lastBriefInput = '';
  briefText =
    '### Who they are\nAdriatic Foods is a wholesale distributor. [W1]\n' +
    '### What you already know\nYou agreed payment terms with them. [M1]\n' +
    '### What is new or changed\nThey opened a warehouse in Zadar. [W2] ' +
    'Distribution margins are typically thin. (unsourced) [W9]\n' +
    '### Contradictions and open questions\nYour notes and the site disagree on size. [M1] [W1]\n' +
    '### Talking points\nAsk about the RC-1 form. [W1]';

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.completeCalls += 1;
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
      // The skill_plan call: two minimised queries, subject kept.
      raw = {
        queries: [
          {
            query: 'Adriatic Foods',
            angle: 'identity',
            reason: 'the subject is the point — nothing else included',
          },
          {
            query: 'Adriatic Foods news',
            angle: 'news',
            reason: 'recent changes — no meeting context included',
          },
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
      // Extraction: one fact per known page, the obligation as a commitment.
      const facts = [];
      if (request.input.includes('RC-1')) {
        facts.push(fact(PROFILE_CLAIM, 'fact'), fact(OBLIGATION_CLAIM, 'commitment'));
      } else {
        facts.push(fact(NEWS_CLAIM, 'fact'));
      }
      raw = { facts };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ModelGatewayError('scripted output failed schema', false);
    return parsed.data;
  }
}

function fact(claim: string, kind: string) {
  return {
    claim,
    kind,
    entities: { people: [], organizations: ['Adriatic Foods'], projects: [] },
    condition: null,
    temporal: { valid_from: null, valid_until: null, anchors_resolved: true },
    source_span: claim,
  };
}

describe('skill runtime (integration: real Postgres + Qdrant, scripted gateway + web)', () => {
  let tdb: TestDatabase;
  let qdrant: TestQdrant;
  let store: MemoryStore;
  let gateway: SkillGateway;
  let research: ResearchService;
  let runs: SkillRunService;
  let engine: SkillEngine;
  let planner: SkillPlanner;
  let sentQueries: string[];
  let seededMemoryId: string;

  const objects = new Proxy(
    {},
    {
      get() {
        throw new Error('unused');
      },
    },
  ) as MemoryObjectStore;

  const buildResearch = (counters: DailyCounters, q: ResearchQuota) => {
    const discovery = new WebDiscoveryService(options);
    discovery.fetchImpl = async (_input, init) => {
      sentQueries.push(String(init?.body));
      return new Response(
        JSON.stringify({
          results: [
            {
              url: 'https://adriaticfoods.example.org/about',
              title: 'Adriatic Foods',
              content: 'about',
              score: 4,
            },
            { url: 'https://news.example.org/af', title: 'AF News', content: 'news', score: 9 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const fetcher = new WebFetchService(options);
    fetcher.resolveAddresses = async () => ['203.0.113.10'];
    fetcher.fetchImpl = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/robots.txt')) return new Response('nope', { status: 404 });
      const html = url.includes('adriaticfoods') ? PAGE_PROFILE : PAGE_NEWS;
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    };
    return new ResearchService(
      tdb.db,
      discovery,
      fetcher,
      objects,
      counters,
      q,
      options,
      gateway,
      store,
    );
  };

  /** Retrieval stubbed to the seeded profile row — planning is deterministic. */
  const stubRetrieval = () =>
    ({
      retrieve: async (_p: unknown, _q: unknown, opts: { rewrite?: { openLoops?: unknown } }) => {
        if (opts.rewrite && (opts.rewrite as { openLoops: unknown }).openLoops) {
          return { memories: [], mode: 'open_loops', openLoops: [] };
        }
        const rows = await tdb.pool.query<{ id: string }>(
          `SELECT id FROM memory WHERE owner_id = $1 AND source_type = 'user_note'`,
          [owner.userId],
        );
        return {
          memories: rows.rows.map((r) => ({
            memory: {
              id: r.id,
              content: 'Agreed 30-day payment terms with Adriatic Foods',
              status: 'active',
              entities: ['Adriatic Foods'],
              subjectEntity: 'Adriatic Foods',
            },
            score: 1,
            signals: ['entity'],
          })),
          mode: 'entity_profile',
          focusEntity: 'Adriatic Foods',
        };
      },
    }) as unknown as RetrievalService;

  const runWorker = async () => {
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
          // The worker-tasks mirror: the settle-watcher runs in the page's own
          // idempotency transaction and branches to skill.advance (0059).
          if (payload.source_type === 'web') {
            await concluder.afterPageProcessed(tx, payload.source_id);
          }
        },
      ),
      [SKILL_ADVANCE_JOB_TYPE]: async (rawPayload) => {
        const runId = (rawPayload as { source_id?: string }).source_id;
        if (runId) await engine.advance(runId);
      },
    };
    await runOnce({ pgPool: tdb.pool, taskList });
    await settleJobs(tdb.pool);
  };

  beforeAll(async () => {
    [tdb, qdrant] = await Promise.all([startTestDatabase(), startTestQdrant()]);
    store = createMemoryStore({
      db: tdb.db,
      qdrant: { url: qdrant.url, embeddingModel: EMBED_MODEL, dimensions: DIMS },
    });
    await store.ensureIndexReady();
    gateway = new SkillGateway();
    sentQueries = [];
    research = buildResearch(new DailyCounters(), quota);
    runs = new SkillRunService(tdb.db);
    engine = new SkillEngine(tdb.db, runs, research, gateway, store, quota);
    planner = new SkillPlanner(stubRetrieval(), research, runs, gateway);

    // A seeded first-person memory — the profile the gather step finds.
    const seeded = await tdb.pool.query<{ id: string }>(
      `INSERT INTO memory
         (owner_id, scope, source_type, source_id, status, content, entities, subject_entity, kind)
       VALUES
         ($1, 'private', 'user_note', gen_random_uuid()::text, 'active',
          'Agreed 30-day payment terms with Adriatic Foods', '{"Adriatic Foods"}',
          'Adriatic Foods', 'decision')
       RETURNING id`,
      [owner.userId],
    );
    seededMemoryId = seeded.rows[0]!.id;
  }, 180_000);

  afterAll(async () => {
    await Promise.all([tdb.stop(), qdrant.stop()]);
  });

  const auditActions = async (entityId: string): Promise<string[]> =>
    (
      await tdb.pool.query<{ action: string }>(
        `SELECT action FROM audit_log WHERE entity_type = 'skill_run' AND entity_id = $1 ORDER BY created_at`,
        [entityId],
      )
    ).rows.map((r) => r.action);

  let firstRunId: string;

  it('run_lifecycle + gate_preserved: plan → gate (nothing sent) → edited approval → worker advance → completed, with a complete step log', async () => {
    const proposal = await planner.propose(owner, 'research_brief', 'Adriatic Foods');
    expect(proposal.status).toBe('created');
    if (proposal.status !== 'created') return;
    const run = proposal.run;
    firstRunId = run.id;
    expect(run.status).toBe('awaiting_approval');

    // The planning half checkpointed: gather + plan completed, the rest pending.
    const planned = await runs.steps(run.id);
    expect(planned.map((s) => [s.stepKey, s.status])).toEqual([
      ['gather_memory', 'completed'],
      ['plan_searches', 'completed'],
      ['gated_search', 'pending'],
      ['read_pages', 'pending'],
      ['verify', 'pending'],
      ['write_brief', 'pending'],
    ]);
    const gatherLinks = planned[0]!.links as SkillStepLinks;
    expect(gatherLinks.memoryIds).toContain(seededMemoryId);

    // THE GATE (gate_preserved): two proposed research runs, nothing sent.
    const plan = await research.runsForSkill(run.id);
    expect(plan).toHaveLength(2);
    expect(plan.every((r) => r.status === 'proposed' && r.sentQuery === null)).toBe(true);
    expect(sentQueries).toHaveLength(0);

    // Approve in ONE interaction: keep both, edit the first.
    const edited = 'Adriatic Foods d.o.o. Split';
    const approved = await engine.approvePlan(owner, run.id, [
      { researchRunId: plan[0]!.id, query: edited },
      { researchRunId: plan[1]!.id, query: plan[1]!.minimisedQuery },
    ]);
    expect(approved.status).toBe('running');
    expect(sentQueries).toHaveLength(0); // approval alone still sends nothing

    await runWorker();

    // Exactly the approved texts left — the edited one verbatim.
    expect(sentQueries).toHaveLength(2);
    expect(sentQueries[0]).toContain(encodeURIComponent(edited).replace(/%20/g, '+'));
    const planAfter = await research.runsForSkill(run.id);
    expect(planAfter.find((r) => r.id === plan[0]!.id)!.sentQuery).toBe(edited);

    // The run completed with the full inspectable log.
    const done = await runs.getRun(owner, run.id);
    expect(done!.status).toBe('completed');
    expect(done!.finishedAt).not.toBeNull();
    const log = await runs.steps(run.id);
    expect(log.every((s) => s.status === 'completed' || s.status === 'skipped')).toBe(true);
    const search = log.find((s) => s.stepKey === 'gated_search')!;
    const searchLinks = search.links as SkillStepLinks;
    expect(searchLinks.searched).toHaveLength(2);
    expect(searchLinks.pageIds!.length).toBeGreaterThanOrEqual(2);
    const read = log.find((s) => s.stepKey === 'read_pages')!;
    expect((read.links as SkillStepLinks).counts!.facts).toBeGreaterThanOrEqual(2);

    // The brief is durable on the run, with resolved citations; the invented
    // [W9] never survives.
    expect(done!.brief).toContain('[W1]');
    expect(done!.brief).toContain('[M1]');
    expect(done!.brief).not.toContain('[W9]');
    expect(done!.brief).toContain('(unsourced)');
    const citations = done!.briefCitations as { kind: string; memoryId?: string; url?: string }[];
    expect(citations.some((c) => c.kind === 'memory' && c.memoryId === seededMemoryId)).toBe(true);
    expect(citations.some((c) => c.kind === 'web' && c.url?.includes('adriaticfoods'))).toBe(true);

    expect(await auditActions(run.id)).toEqual([
      'skill_run.proposed',
      'skill_run.plan_approved',
      'skill_run.completed',
    ]);
  });

  it('creates_nothing: a full run produces a brief and NO durable artifact of its own', async () => {
    // The skill runtime reads, searches and writes a brief. Since decision 0060
    // there is nothing task-shaped left for it to propose, so the run's ONLY
    // durable outputs are its step log, its research runs, and the brief.
    const run = await runs.getRun(owner, firstRunId);
    expect(run!.brief).toBeTruthy();
    const steps = await runs.steps(firstRunId);
    expect(steps.map((s) => s.stepKey)).not.toContain('propose_actions');
    expect(steps.every((s) => s.status === 'completed' || s.status === 'skipped')).toBe(true);
  });

  it('run_resumable: a re-delivered advance changes nothing on a finished run; mid-run re-delivery never duplicates searches or pages', async () => {
    const sentBefore = sentQueries.length;
    const pagesBefore = Number(
      (await tdb.pool.query(`SELECT count(*)::int AS n FROM web_page`)).rows[0]!.n,
    );
    // Finished run: advance is a no-op.
    expect(await engine.advance(firstRunId)).toEqual({ advanced: false });

    // Mid-run: approve a fresh run, advance TWICE by hand (a duplicate
    // delivery) — searches and captures happen exactly once.
    const proposal = await planner.propose(owner, 'research_brief', 'Adriatic Foods');
    if (proposal.status !== 'created') throw new Error('expected a run');
    const plan = await research.runsForSkill(proposal.run.id);
    await engine.approvePlan(
      owner,
      proposal.run.id,
      plan.map((r) => ({ researchRunId: r.id, query: r.minimisedQuery })),
    );
    await engine.advance(proposal.run.id);
    const sentAfterFirst = sentQueries.length;
    const pagesAfterFirst = Number(
      (await tdb.pool.query(`SELECT count(*)::int AS n FROM web_page`)).rows[0]!.n,
    );
    expect(sentAfterFirst).toBe(sentBefore + 2);
    await engine.advance(proposal.run.id); // duplicate delivery
    expect(sentQueries.length).toBe(sentAfterFirst);
    expect(
      Number((await tdb.pool.query(`SELECT count(*)::int AS n FROM web_page`)).rows[0]!.n),
    ).toBe(pagesAfterFirst);
    expect(pagesAfterFirst).toBeGreaterThan(pagesBefore);

    // Let it finish so later tests see a quiet queue.
    await runWorker();
    expect((await runs.getRun(owner, proposal.run.id))!.status).toBe('completed');
  });

  it('budget_caps_run: hitting the daily search budget completes the run gracefully with partial results and an honest note', async () => {
    sentQueries = [];
    const tightQuota: ResearchQuota = { ...quota, searchesMax: 1 };
    const tightResearch = buildResearch(new DailyCounters(), tightQuota);
    const tightEngine = new SkillEngine(tdb.db, runs, tightResearch, gateway, store, tightQuota);
    const tightPlanner = new SkillPlanner(stubRetrieval(), tightResearch, runs, gateway);

    const proposal = await tightPlanner.propose(owner, 'research_brief', 'Adriatic Foods');
    if (proposal.status !== 'created') throw new Error('expected a run');
    const plan = await tightResearch.runsForSkill(proposal.run.id);
    expect(plan).toHaveLength(2);
    await tightEngine.approvePlan(
      owner,
      proposal.run.id,
      plan.map((r) => ({ researchRunId: r.id, query: r.minimisedQuery })),
    );
    await tightEngine.advance(proposal.run.id);
    expect(sentQueries).toHaveLength(1); // the second search hit the cap

    const log = await runs.steps(proposal.run.id);
    const search = log.find((s) => s.stepKey === 'gated_search')!;
    expect(search.status).toBe('completed');
    const links = search.links as SkillStepLinks;
    expect(links.notes!.join(' ')).toContain('daily research budget reached');
    expect(search.outputsSummary).toContain('skipped at the budget');

    // The engine that continues must share the tight research service so the
    // remaining steps read the same world; the run still completes.
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
        const runId = (rawPayload as { source_id?: string }).source_id;
        if (runId) await tightEngine.advance(runId);
      },
    };
    await runOnce({ pgPool: tdb.pool, taskList });
    await settleJobs(tdb.pool);

    const done = await runs.getRun(owner, proposal.run.id);
    expect(done!.status).toBe('completed');
    expect(done!.brief).toBeTruthy(); // partial results kept, brief written
  });

  it('cancellation stops cleanly and keeps what was produced', async () => {
    const proposal = await planner.propose(owner, 'research_brief', 'Adriatic Foods');
    if (proposal.status !== 'created') throw new Error('expected a run');
    const cancelled = await runs.cancel(owner, proposal.run.id);
    expect(cancelled.status).toBe('cancelled');
    // The planning log survives; advance refuses to touch the run.
    const log = await runs.steps(proposal.run.id);
    expect(log.find((s) => s.stepKey === 'gather_memory')!.status).toBe('completed');
    expect(await engine.advance(proposal.run.id)).toEqual({ advanced: false });
    expect(await auditActions(proposal.run.id)).toEqual([
      'skill_run.proposed',
      'skill_run.cancelled',
    ]);
  });
});
