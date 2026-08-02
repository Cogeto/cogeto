import 'reflect-metadata';
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait } from 'testcontainers';
import type { ChatStreamEvent, Principal } from '@cogeto/shared';
import { applyMigrations, createDb, UserContextService } from '../infrastructure/index';
import { createMemoryReconciliation, createMemoryStore, MemoryObjectStore } from '../memory/index';
import type { MemoryRow } from '../memory/index';
import {
  buildDreamDigest,
  DreamingService,
  INGESTION_PIPELINE_JOB_TYPE,
  ReconciliationService,
  seedMemoryFromSource,
} from '../ingestion/index';
import { UserDirectory } from '../identity/index';
import { ANSWER_PROMPT, ChatService, RetrievalService } from '../retrieval/index';
import { ActionRegistry, ApprovalService } from '../agents/index';
import { ChatReplyResolver, EmailReplyDraftService, EmailSourceService } from '../email/index';
import {
  ChatResearchResolver,
  ResearchService,
  ResearchSynthesisService,
  WebDiscoveryService,
  WebFetchService,
} from '../research/index';
import { ChatSkillResolver, SkillEngine, SkillPlanner, SkillRunService } from '../connectors/index';
import type { ResearchOptions } from '../research/index';
import { InMemoryDailyCounters } from '../infrastructure/index';
import { createModelGateway, loadPrompt, ModelGateway } from '../model-gateway/index';
import type { ResolvedModelProviders } from '../model-gateway/index';
import { resolveEvalProviders, requireConfiguredProviders } from './eval-env';
import { EVAL_SCORING_VERSION, evalCacheModeFromEnv, wrapWithEvalCache } from './eval-cache';
import { configurationForEmission, emitPartial, TRUST_SCORES_SCHEMA_VERSION } from './trust-scores';

/** The inbound address seeded emails are addressed to (chat reply-intent cases). */
const EVAL_INBOUND = 'capture@in.localhost';

/**
 * npm run eval:chat — the chat-answer eval suite (§2). It seeds a FRESH
 * test instance (Testcontainers Postgres + Qdrant) with each case's notes
 * through the REAL pipeline (extract → verify → embed + store, live model),
 * then runs the case's scripted conversation through the REAL chat path
 * (RetrievalService + ChatService.ask — the endpoint's entire behavior; the
 * HTTP+Zitadel wrapper is skipped deliberately) and scores the answers.
 *
 * Scoring is deterministic where possible (entity-name assertions, mechanics
 * regex, citation-violation count from the done event) plus one model-graded
 * coverage judgment via the gateway with the versioned `eval-coverage/v0001`
 * rubric. Results append to docs/eval/history.md with prompt + model versions.
 *
 * This is a live, container-backed harness — run it by hand / in CI with a key,
 * not in the unit suite.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'project', 'src', 'migrations');
const CASES_DIR = path.join(REPO_ROOT, 'project', 'eval', 'chat');
const CACHE_DIR = path.join(REPO_ROOT, 'project', 'eval', 'cache');
const GATES_FILE = path.join(REPO_ROOT, 'project', 'eval', 'gates.json');
const HISTORY_FILE = path.join(REPO_ROOT, 'docs', 'eval', 'history.md');

const COVERAGE_PROMPT = { family: 'eval-coverage', version: 'v0001' } as const;

/**
 * Direct-fact seeding: temporal cases need deterministic supersession
 * chains and fixed interval dates — extraction quality is scored elsewhere.
 * `supersedes` points at an earlier fact by index; seeding runs the REAL
 * supersession mechanics (interval close, replaced, pointer).
 */
const factSeedSchema = z.object({
  content: z.string().min(1),
  kind: z.enum(['commitment', 'decision', 'preference', 'fact', 'open_loop']).default('fact'),
  entities: z.array(z.string()).default([]),
  subject_entity: z.string().nullable().default(null),
  valid_from: z.string().optional(),
  valid_until: z.string().optional(),
  supersedes: z.int().min(0).optional(),
  /** Seed this fact already reconciliation-flagged (skill contradiction cases)
   * the deterministic input state; live contradiction DETECTION has its own
   * reconcile suite. */
  contradicted: z.boolean().optional(),
});

/** Seeded email_message rows. */
const emailSeedSchema = z.object({
  from: z.string().min(1),
  subject: z.string().optional(),
  text: z.string().default(''),
  message_id: z.string().optional(),
});

const caseSchema = z.object({
  case_id: z.string(),
  description: z.string().default(''),
  anchor: z.string(),
  notes: z.array(z.string()).default([]),
  facts: z.array(factSeedSchema).default([]),
  /** Emails to seed for a draft-a-reply case. */
  emails: z.array(emailSeedSchema).default([]),
  /**
   * Research cases: a scripted public web (discovery
   * returns these pages; the fetcher serves their HTML — nothing real is
   * fetched in the harness). After the chat turns open the gate, the harness
   * stands in for the user at the Research page: it approves the LIVE
   * minimised query, captures the pages, seeds their memories through the
   * real pipeline stages, and runs the LIVE answer-tier synthesis.
   */
  research: z
    .object({
      pages: z
        .array(z.object({ url: z.string(), html: z.string(), title: z.string().optional() }))
        .min(1),
      /** Substrings the synthesised research answer must contain. */
      answer_must_include: z.array(z.string()).default([]),
      /** LIVE minimisation verdicts, judged on the query that actually LEFT
       * (the harness approves the minimised query verbatim): what must have
       * been dropped (minimise_drops_client) / kept (minimise_keeps_subject). */
      sent_query_must_exclude: z.array(z.string()).default([]),
      sent_query_must_include: z.array(z.string()).default([]),
    })
    .optional(),
  /**
   * Skill cases: the script's last turn invokes
   * the research-brief skill; the harness stands in for the user at the plan
   * gate (approves the first two LIVE-planned queries verbatim, removes the
   * rest — exercising removal), stands in for the worker (fixture pages, real
   * pipeline stages), and asserts on the finished run: a complete step log,
   * memory + web citations on the brief, contradiction counts surfaced,
   * resolved-only markers.
   */
  skill: z
    .object({
      pages: z
        .array(z.object({ url: z.string(), html: z.string(), title: z.string().optional() }))
        .min(1),
      /** Substrings the brief must contain (kept loose — live model). */
      brief_must_include: z.array(z.string()).default([]),
      /** The seeded contradicted fact must surface in the verify step. */
      expect_contradiction: z.boolean().default(false),
      /** The brief must cite at least one pre-existing (seeded) memory. */
      expect_memory_citation: z.boolean().default(true),
      /** The brief's language (anchor), judged deterministically. */
      language: z.enum(['en', 'hr']).optional(),
    })
    .optional(),
  /** Per-case user context: applied through the real
   * UserContextService before the scripted turns. */
  settings: z
    .object({
      display_name: z.string().optional(),
      company: z.string().optional(),
      role_title: z.string().optional(),
      preferred_language: z.enum(['en', 'hr']).optional(),
      language_strict: z.boolean().optional(),
    })
    .optional(),
  script: z.array(z.string()).min(1),
  checks: z.object({
    entity: z
      .object({ mustMention: z.array(z.string()), notIdentity: z.array(z.string()) })
      .optional(),
    coverage_facts: z.array(z.string()).optional(),
    coverage_target: z.number().min(0).max(1).default(0.8),
    hedge: z.object({ term: z.string() }).optional(),
    no_mechanics: z.boolean().optional(),
    citations_valid: z.boolean().optional(),
    nothing_on_record: z.boolean().optional(),
    /** Substrings the final answer must contain (temporal/open-loops cases). */
    must_include: z.array(z.string()).optional(),
    /** Substrings the final answer must NOT contain (settled obligations). */
    must_exclude: z.array(z.string()).optional(),
    /** The answer must frame past belief as past. */
    past_framing: z.boolean().optional(),
    /** The final turn's sources must include / must not include these statuses. */
    sources_status_includes: z.array(z.string()).optional(),
    sources_status_excludes: z.array(z.string()).optional(),
    /**
     * Conversation checks, folded into one deterministic
     * verdict like the temporal set
     * - `research_offer` — the final turn's done event carries the research
     *   OFFER and no research_run row exists (a knowledge question never
     *   silently reaches the gate, let alone a search).
     * - `unsourced_required` — the final stored answer carries at least one
     *   canonical `{{unsourced}}` marker (per-claim origin honesty).
     * - `smalltalk` — the final turn produced no sources and no citation
     *   tokens, and its answer is a natural reply, not the nothing-on-record
     *   fallback.
     */
    research_offer: z.boolean().optional(),
    unsourced_required: z.boolean().optional(),
    smalltalk: z.boolean().optional(),
    /**
     * Language checks, folded into the conversation
     * verdict
     * - `language` — the final answer's language, judged deterministically
     *   (Croatian diacritics + stopword balance). With strict mode set this
     *   proves an en question comes back hr; without it, mirroring.
     * - `digest_language` — after the turns, the harness runs a REAL dreaming
     *   cycle and builds the digest with the case's preferred language; the
     *   lines must exist and speak it (Cogeto-initiated content anchors to
     *   preferred_language, never the question's language).
     */
    language: z.enum(['en', 'hr']).optional(),
    digest_language: z.enum(['en', 'hr']).optional(),
  }),
});
type ChatCase = z.infer<typeof caseSchema>;

const coverageSchema = z.object({
  results: z.array(z.object({ index: z.number(), covered: z.boolean() })),
});

const PRINCIPAL: Principal = {
  userId: 'chat-eval-user',
  name: 'Chat Eval',
  email: null,
  orgId: 'chat-eval-org',
  orgName: 'Chat Eval',
  roles: [],
};

interface TurnResult {
  question: string;
  answer: string;
  sourceCount: number;
  sourceStatuses: string[];
  citationViolations: number;
  /** Whether the done event carried the research offer. */
  researchOffer: boolean;
}

interface CaseScore {
  caseId: string;
  entityCorrect: boolean | null;
  coverage: number | null;
  coverageTarget: number;
  hedgeMarked: boolean | null;
  noMechanics: boolean | null;
  citationsValid: boolean | null;
  nothingOnRecord: boolean | null;
  /** The temporal checks folded into one verdict (null = not a temporal case). */
  temporal: boolean | null;
  /** The research-flow verdict (Part B; null = not a research case): gate →
   * approve → capture → cited synthesis → persisted web memories. */
  research: boolean | null;
  /** The skill-run verdict (null = not a skill case): plan gate →
   * worker steps → a cited brief with contradictions surfaced. */
  skill: boolean | null;
  /** The folded conversation verdict (null = no such checks)
   * research offer without a silent search, unsourced marking, small talk. */
  conversation: boolean | null;
  pass: boolean;
}

/** Past framing: the answer talks about the past in en or hr. */
const PAST_FRAMING_RE =
  /\b(until|previously|used to|no longer|was|were|at the time|as of|before|earlier|since then|replaced|changed to|prije|do\s|više ne|bilo je|bila je|tada|od tada|zamijenjen)\b/i;

/**
 * The eval grader follows the answer tier unless overridden (
 * ruling 3): COGETO_PROVIDER_GRADER / COGETO_MODEL_GRADER re-bind ONLY the
 * grading calls (harness-only vars, never read by the instance). An override
 * changes comparability — note it when publishing.
 */
function graderProvidersFrom(providers: ResolvedModelProviders): ResolvedModelProviders | null {
  const providerVar = process.env.COGETO_PROVIDER_GRADER?.trim();
  const modelVar = process.env.COGETO_MODEL_GRADER?.trim();
  if (!providerVar && !modelVar) return null;
  const provider =
    (providerVar as ResolvedModelProviders['tiers']['answer']['provider']) ??
    providers.tiers.answer.provider;
  const model = modelVar ?? providers.tiers.answer.model;
  if (providerVar && !['mistral', 'openai', 'anthropic'].includes(providerVar)) {
    console.error(`COGETO_PROVIDER_GRADER="${providerVar}" is not a known provider`);
    process.exit(2);
  }
  if (!providers.keys[provider]) {
    console.error(`COGETO_PROVIDER_GRADER="${provider}" has no API key configured`);
    process.exit(2);
  }
  return { ...providers, tiers: { ...providers.tiers, answer: { provider, model } } };
}

async function loadCases(): Promise<ChatCase[]> {
  const dirs = (await readdir(CASES_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const cases: ChatCase[] = [];
  for (const dir of dirs) {
    const raw = await readFile(path.join(CASES_DIR, dir, 'case.json'), 'utf8');
    cases.push(caseSchema.parse(JSON.parse(raw)));
  }
  return cases;
}

/** Strip canonical cites so coverage grading sees prose only. */
const stripCites = (text: string): string => text.replace(/\{\{cite:[^}]+\}\}/g, '').trim();

function checkEntity(answer: string, entity: NonNullable<ChatCase['checks']['entity']>): boolean {
  const lower = answer.toLowerCase();
  const mentions = entity.mustMention.every((m) => lower.includes(m.toLowerCase()));
  const conflated = entity.notIdentity.some((name) =>
    new RegExp(`\\b(?:she|he|ana|ana\\s+kova[čc])\\s+is\\s+${name.toLowerCase()}\\b`, 'i').test(
      answer,
    ),
  );
  return mentions && !conflated;
}

function checkNoMechanics(answer: string): boolean {
  const leaks = [
    /\breferenced in\b/i,
    /\bfacts?\s+\d+\b/i,
    /\[f\d+\]/i,
    /\baccording to fact\b/i,
    /\bfact\s*#?\s*\d+\b/i,
  ];
  return !leaks.some((re) => re.test(answer));
}

/**
 * The nothing-on-record guard passes when the system DECLINES rather than
 * fabricates. Retrieval fuses vector neighbours and so rarely returns literally
 * zero facts for an unrelated question; the answer model then declines on
 * relevance ("the facts do not cover this") instead of hitting the canned
 * zero-retrieval string. Either form is a correct refusal.
 */
function checkNothingOnRecord(answer: string): boolean {
  return /\b(do(?:es)?\s*n.?t\s+cover|not\s+covered|nothing\s+(?:on\s+record|to\s+answer|on\s+that|about)|do(?:es)?\s*n.?t\s+have\s+anything|have\s+nothing|no\s+(?:information|facts|record|relevant)|can.?not?\s+answer|suggest\s+capturing|captur\w*\s+.*note)\b/i.test(
    answer,
  );
}

/**
 * Deterministic language judgment: Croatian diacritics are a strong
 * signal; a stopword balance decides otherwise. Names stay untranslated, so
 * only function words count.
 */
const HR_DIACRITICS = /[čćžšđ]/i;
const HR_WORDS =
  /\b(je|su|za|još|nije|nema|sam|smo|ali|kao|ovo|ili|obveza|zadatak|zadaci|tjedan|tjedna|rok|dana|prema|koja|koji|radionica|sastanak)\b/gi;
const EN_WORDS =
  /\b(the|is|are|you|your|have|has|and|week|due|task|tasks|nothing|open|with|that|this|workshop|meeting)\b/gi;

function checkLanguage(text: string, lang: 'en' | 'hr'): boolean {
  const t = stripCites(text);
  const hrScore = (t.match(HR_WORDS)?.length ?? 0) + (HR_DIACRITICS.test(t) ? 3 : 0);
  const enScore = t.match(EN_WORDS)?.length ?? 0;
  return lang === 'hr' ? hrScore > enScore : enScore > hrScore;
}

function checkHedge(answer: string, term: string): boolean {
  if (!new RegExp(`\\b${term}\\b`, 'i').test(answer)) return true; // vacuous: not mentioned
  return /\buncertain|unconfirmed|not\s+(yet\s+)?confirmed|might|possibly|tentativ|wasn.?t\s+sure|may\s+prefer/i.test(
    answer,
  );
}

async function gradeCoverage(
  gateway: ModelGateway,
  graderPrompt: string,
  answer: string,
  facts: string[],
): Promise<{ fraction: number; missed: string[] }> {
  const input = [
    'ASSISTANT ANSWER:',
    stripCites(answer) || '(empty answer)',
    '',
    'EXPECTED FACTS:',
    ...facts.map((f, i) => `${i + 1}. ${f}`),
  ].join('\n');
  const graded = await gateway.extractStructured(coverageSchema, {
    system: graderPrompt,
    input,
    tier: 'answer',
  });
  const coveredIdx = new Set(graded.results.filter((r) => r.covered).map((r) => r.index));
  const missed = facts.filter((_, i) => !coveredIdx.has(i + 1));
  const fraction = facts.length === 0 ? 1 : (facts.length - missed.length) / facts.length;
  return { fraction, missed };
}

async function main(): Promise<void> {
  const { providers, redaction } = await resolveEvalProviders(REPO_ROOT);
  const cacheMode = evalCacheModeFromEnv();
  // A replay needs no provider at all — that is the point on a fork pull
  // request, where no secret exists.
  if (cacheMode !== 'replay') requireConfiguredProviders(providers, 'eval:chat');
  const { gateway, store: cacheStore } = wrapWithEvalCache(
    createModelGateway({
      providers,
      redaction,
      // Deterministic sampling for comparable runs: stabilizes
      // both the answers under test and the coverage grader (where the provider
      // accepts a temperature — 0040 ruling 1).
      temperature: 0,
    }),
    { mode: cacheMode, dir: CACHE_DIR, providers },
  );
  if (cacheMode === 'replay') {
    console.log(
      'CACHED REPLAY: catches prompt, pipeline and scoring regressions. It does NOT catch ' +
        'model-side drift, and it is never published as a trust score.',
    );
  } else if (cacheMode === 'record') {
    console.log(`RECORDING eval cache → ${path.relative(REPO_ROOT, CACHE_DIR)}`);
  }
  // Grader override (0040 ruling 3): a separate gateway ONLY for gradeCoverage.
  // Cached through the SAME store: the grader's judgment is part of what a
  // cached run must reproduce.
  const graderProviders = graderProvidersFrom(providers);
  const graderGateway = graderProviders
    ? wrapWithEvalCache(
        createModelGateway({ providers: graderProviders, redaction, temperature: 0 }),
        { mode: cacheMode, dir: CACHE_DIR, providers: graderProviders, store: cacheStore },
      ).gateway
    : gateway;
  if (graderProviders) {
    console.log(
      `grader override: ${graderProviders.tiers.answer.provider}/${graderProviders.tiers.answer.model} ` +
        '(COGETO_PROVIDER_GRADER/COGETO_MODEL_GRADER), note this when publishing',
    );
  }
  const graderPrompt = (await loadPrompt(COVERAGE_PROMPT.family, COVERAGE_PROMPT.version)).content;
  const cases = await loadCases();

  console.log('starting Postgres + Qdrant test containers…');
  const pg = await new PostgreSqlContainer('postgres:17-alpine').start();
  const qdrant = await new GenericContainer('qdrant/qdrant:v1.14.0')
    .withExposedPorts(6333)
    .withWaitStrategy(Wait.forHttp('/readyz', 6333))
    .start();
  const qdrantUrl = `http://${qdrant.getHost()}:${qdrant.getMappedPort(6333)}`;
  const pool = new Pool({ connectionString: pg.getConnectionUri() });

  const scores: CaseScore[] = [];
  try {
    await applyMigrations(pool, MIGRATIONS_DIR);
    const db = createDb(pool);
    const embeddingModel = gateway.embeddingModelId();

    for (const testCase of cases) {
      console.log(`\n=== ${testCase.case_id} ===`);
      // A fresh, isolated instance per case: its own Qdrant collection AND its
      // own Postgres owner (the FTS/entity gates are owner-scoped, so a shared
      // owner would leak other cases' memories into this one).
      const collection = `chat_eval_${testCase.case_id}`;
      const principal: Principal = { ...PRINCIPAL, userId: `chat-eval-${testCase.case_id}` };
      const memoryStore = createMemoryStore({
        db,
        qdrant: { url: qdrantUrl, embeddingModel, collection },
      });
      await memoryStore.ensureIndexReady();
      const retrieval = new RetrievalService(memoryStore, gateway, { db });
      // The chat → email-reply resolver: draft-a-reply cases seed
      // emails and exercise the real drafting path (the confirmation text is
      // deterministic; the model only writes the draft body, which is not graded).
      // The object store is never called for seeded text emails.
      const objects = new MemoryObjectStore({
        url: 'http://127.0.0.1:1',
        accessKey: 'unused',
        secretKey: 'unused',
        bucket: 'cogeto',
      });
      const approvals = new ApprovalService(db, new ActionRegistry(memoryStore));
      const emailDrafts = new EmailReplyDraftService(db, retrieval, gateway, approvals);
      const replyResolver = new ChatReplyResolver(new EmailSourceService(db, objects), emailDrafts);
      // The research seam (Part B): scripted web, LIVE minimisation/synthesis.
      const researchOptions: ResearchOptions = {
        searxngUrl: 'http://searxng.eval.invalid:8080',
        resultCap: 8,
        searchTimeoutMs: 2_000,
        fetchTimeoutMs: 2_000,
        fetchMaxBytes: 1024 * 1024,
        retainHtml: false,
      };
      const evalPages = testCase.research?.pages ?? testCase.skill?.pages ?? [];
      const discovery = new WebDiscoveryService(researchOptions);
      discovery.fetchImpl = async () =>
        new Response(
          JSON.stringify({
            results: evalPages.map((p) => ({ url: p.url, title: p.title ?? p.url, content: '' })),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      const fetcher = new WebFetchService(researchOptions);
      fetcher.resolveAddresses = async () => ['203.0.113.10'];
      fetcher.fetchImpl = async (input) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith('/robots.txt')) return new Response('nope', { status: 404 });
        const page = evalPages.find((p) => url.startsWith(p.url));
        return page
          ? new Response(page.html, { status: 200, headers: { 'content-type': 'text/html' } })
          : new Response('not found', { status: 404 });
      };
      const research = new ResearchService(
        db,
        discovery,
        fetcher,
        objects,
        new InMemoryDailyCounters(),
        {
          searchesMax: 100,
          pagesMax: 100,
          pagesPerRunMax: 8,
          skillQueriesMax: 6,
          skillPagesPerQuery: 3,
        },
        researchOptions,
        gateway,
        memoryStore,
      );
      const researchResolver = new ChatResearchResolver(research);
      // The skill seam: the planner runs LIVE
      // (real retrieval + the skill_plan prompt); execution below is the
      // harness standing in for the worker.
      const skillRuns = new SkillRunService(db);
      const skillPlanner = new SkillPlanner(retrieval, research, skillRuns, gateway);
      const skillResolver = new ChatSkillResolver(skillPlanner, skillRuns);
      // Per-case user context: applied through the real service, so the
      // chat path exercises the same now-block assembly as production.
      const userContextService = new UserContextService(db);
      if (testCase.settings) {
        await userContextService.update(
          { userId: principal.userId, orgId: principal.orgId },
          {
            displayName: testCase.settings.display_name ?? null,
            company: testCase.settings.company ?? null,
            roleTitle: testCase.settings.role_title ?? null,
            preferredLanguage: testCase.settings.preferred_language,
            languageStrict: testCase.settings.language_strict,
          },
        );
      }
      const chat = new ChatService(db, retrieval, gateway, new UserDirectory(db), {
        replyResolver,
        researchResolver,
        userContext: userContextService,
        skillResolver,
      });
      const anchor = new Date(testCase.anchor);

      // Seed emails ( reply-intent cases) directly — no public seed API.
      for (let i = 0; i < testCase.emails.length; i++) {
        const e = testCase.emails[i]!;
        await db.execute(sql`
          INSERT INTO email_message
            (owner_id, scope, from_addr, to_addr, subject, message_id, received_at,
             raw_object_key, text_body, headers_json, has_attachments)
          VALUES
            (${principal.userId}, 'private', ${e.from}, ${EVAL_INBOUND}, ${e.subject ?? null},
             ${e.message_id ?? null}, ${anchor.toISOString()},
             ${`eval/${testCase.case_id}/email-${i}`}, ${e.text}, '{}'::jsonb, false)
        `);
      }

      // Seed through the real pipeline (extraction → verification → admission),
      // exactly as the worker would.
      for (let i = 0; i < testCase.notes.length; i++) {
        const sourceId = `chat-eval-${testCase.case_id}-${i}`;
        await seedMemoryFromSource({
          db,
          gateway,
          memoryStore,
          source: {
            sourceType: 'user_note',
            sourceId,
            ownerId: principal.userId,
            content: testCase.notes[i]!,
            // Mirror the note SourceReader: a note is the user's own voice, so
            // its obligations pass the first-person rule and reach open loops.
            // The seed builds its own SourceItem, so it must say so explicitly.
            authoredByUser: true,
            createdAt: anchor,
          },
        });
      }
      // Direct-fact seeding: fixed dates + real supersession mechanics.
      const seededRows: MemoryRow[] = [];
      for (let i = 0; i < testCase.facts.length; i++) {
        const seed = testCase.facts[i]!;
        const fact = {
          content: seed.content,
          scope: 'private' as const,
          sourceType: 'user_note' as const,
          sourceId: `chat-eval-${testCase.case_id}-fact-${i}`,
          entities: seed.entities,
          subjectEntity: seed.subject_entity ?? undefined,
          kind: seed.kind,
          validFrom: seed.valid_from ? new Date(seed.valid_from) : undefined,
          validUntil: seed.valid_until ? new Date(seed.valid_until) : undefined,
          // Seeds stand in for the user's own notes, which is what the note
          // SourceReader stamps, so open-loop cases see first-person facts.
          authoredByUser: true,
          embeddingModel,
        };
        const row =
          seed.supersedes !== undefined
            ? (
                await memoryStore.supersede(
                  { kind: 'user', userId: principal.userId },
                  seededRows[seed.supersedes]!.id,
                  fact,
                )
              ).successor
            : await memoryStore.createFromFact(principal, fact);
        seededRows.push(row);
      }
      if (seededRows.length > 0) {
        const vectors = await gateway.embed(seededRows.map((row) => row.content ?? ''));
        // Re-read rows so predecessors carry their closed intervals/pointers.
        const fresh = await memoryStore.getManyForPrincipal(
          principal,
          seededRows.map((r) => r.id),
        );
        const byId = new Map(fresh.map((r) => [r.id, r]));
        await memoryStore.upsertVectors(
          seededRows.map((r) => byId.get(r.id) ?? r),
          vectors,
        );
      }
      // Pre-flagged disputes (skill contradiction cases): the seeded fact
      // enters already `contradicted` — deterministic input state; live
      // contradiction DETECTION is the reconcile suite's job.
      for (let i = 0; i < testCase.facts.length; i++) {
        if (testCase.facts[i]!.contradicted) {
          await db.execute(
            sql`UPDATE memory SET status = 'contradicted' WHERE id = ${seededRows[i]!.id}`,
          );
        }
      }
      console.log(`  seeded ${testCase.notes.length} notes, ${testCase.facts.length} direct facts`);

      // Run the scripted conversation — inside ONE conversation container
      //, exactly as the production surface would: the script's turns
      // share turn context, other conversations' turns never enter.
      const conversationRef = await chat.createConversation(principal);
      const turns: TurnResult[] = [];
      for (const question of testCase.script) {
        let answer = '';
        let sourceCount = 0;
        let sourceStatuses: string[] = [];
        let citationViolations = 0;
        let researchOffer = false;
        for await (const event of chat.ask(
          principal,
          question,
          conversationRef.id,
        ) as AsyncIterable<ChatStreamEvent>) {
          if (event.type === 'sources') {
            sourceCount = event.facts.length;
            sourceStatuses = event.facts.map((f) => f.status);
          } else if (event.type === 'done') {
            answer = event.content;
            citationViolations = event.citationViolations;
            researchOffer = Boolean(event.researchOffer);
          }
        }
        turns.push({
          question,
          answer,
          sourceCount,
          sourceStatuses,
          citationViolations,
          researchOffer,
        });
        console.log(
          `  Q: ${question}\n  A (${sourceCount} facts): ${stripCites(answer).slice(0, 220)}`,
        );
      }

      const final = turns[turns.length - 1]!;
      const checks = testCase.checks;

      // Research cases (Part B): the chat turn opened the gate; now stand in
      // for the user's approval and the worker's pipeline, then synthesise.
      let researchOk: boolean | null = null;
      if (testCase.research) {
        try {
          const runs = await db.execute<{
            id: string;
            minimised_query: string;
            status: string;
          }>(sql`
            SELECT id, minimised_query, status FROM research_run
            WHERE owner_id = ${principal.userId} ORDER BY created_at DESC LIMIT 1
          `);
          const run = runs.rows[0];
          if (!run || run.status !== 'proposed') {
            console.log(`  research: no proposed run after the chat turn, FAIL`);
            researchOk = false;
          } else {
            const { search } = await research.approveAndSearch(
              principal,
              run.id,
              run.minimised_query, // approve the LIVE minimised query as-is
            );
            const captured = await research.capture(
              principal,
              testCase.research.pages.map((p) => p.url),
              'private',
              run.id,
            );
            const pageIds = captured.flatMap((r) => (r.status === 'captured' ? [r.id] : []));
            // The worker's stand-in: real extract → verify → embed per page.
            let webMemories = 0;
            for (const pageId of pageIds) {
              const page = (await research.getForOwner(principal, pageId))!;
              await seedMemoryFromSource({
                db,
                gateway,
                memoryStore,
                source: {
                  sourceType: 'web',
                  sourceId: pageId,
                  ownerId: principal.userId,
                  content: page.title ? `${page.title}\n\n${page.retainedText}` : page.retainedText,
                  // Mirror the web SourceReader: a fetched page is not the user's voice.
                  authoredByUser: false,
                  createdAt: anchor,
                },
              });
              webMemories += (await memoryStore.listBySourceSystem('web', pageId)).length;
            }
            const synthesis = new ResearchSynthesisService(research, gateway, { retrieval });
            const answer = await synthesis.synthesise(principal, run.id);
            const cited = answer.citations.some((c) => c.kind === 'web');
            const included = testCase.research.answer_must_include.every((sub) =>
              answer.answer.toLowerCase().includes(sub.toLowerCase()),
            );
            const sent = run.minimised_query.toLowerCase();
            const sentOk =
              testCase.research.sent_query_must_exclude.every(
                (sub) => !sent.includes(sub.toLowerCase()),
              ) &&
              testCase.research.sent_query_must_include.every((sub) =>
                sent.includes(sub.toLowerCase()),
              );
            researchOk =
              search.status === 'ok' &&
              pageIds.length > 0 &&
              webMemories > 0 &&
              cited &&
              included &&
              sentOk;
            console.log(
              `  research: search=${search.status} pages=${pageIds.length} memories=${webMemories} ` +
                `webCited=${String(cited)} include=${String(included)} sentQueryOk=${String(sentOk)}` +
                `\n  sent query: ${run.minimised_query}` +
                `\n  research answer: ${answer.answer.slice(0, 220)}`,
            );
          }
        } catch (error) {
          console.log(
            `  research flow FAILED: ${error instanceof Error ? error.message : String(error)}`,
          );
          researchOk = false;
        }
      }

      // Skill cases: the chat turn started
      // planning; now stand in for the user at the plan gate and for the
      // worker's advance, then assert on the finished run.
      let skillOk: boolean | null = null;
      if (testCase.skill) {
        try {
          const runRows = await db.execute<{ id: string; status: string }>(sql`
            SELECT id, status FROM skill_run
            WHERE owner_id = ${principal.userId} ORDER BY created_at DESC LIMIT 1
          `);
          const runRow = runRows.rows[0];
          if (!runRow || runRow.status !== 'awaiting_approval') {
            console.log(
              `  skill: no run awaiting approval after the chat turn (status=${runRow?.status ?? 'none'}), FAIL`,
            );
            skillOk = false;
          } else {
            const engine = new SkillEngine(
              db,
              skillRuns,
              research,
              gateway,
              memoryStore,
              {
                searchesMax: 100,
                pagesMax: 100,
                pagesPerRunMax: 8,
                skillQueriesMax: 6,
                skillPagesPerQuery: 1,
              },
              { userContext: userContextService },
            );
            // The plan gate, one interaction: keep the first two LIVE-planned
            // queries verbatim, remove the rest (removal is part of the claim).
            const plan = await research.runsForSkill(runRow.id);
            const kept = plan.slice(0, 2);
            await engine.approvePlan(
              principal,
              runRow.id,
              kept.map((r) => ({ researchRunId: r.id, query: r.minimisedQuery })),
            );
            // Advance 1: discovery + capture through the real gate machinery.
            await engine.advance(runRow.id);
            // The worker's stand-in per captured page: real pipeline stages
            // plus the settle ledger the advance job waits on.
            const pages = await db.execute<{ id: string; title: string | null; text: string }>(sql`
              SELECT wp.id, wp.title, wp.retained_text AS text FROM web_page wp
              JOIN research_run rr ON rr.id = wp.research_run_id
              WHERE rr.skill_run_id = ${runRow.id}
            `);
            for (const page of pages.rows) {
              await seedMemoryFromSource({
                db,
                gateway,
                memoryStore,
                source: {
                  sourceType: 'web',
                  sourceId: page.id,
                  ownerId: principal.userId,
                  content: page.title ? `${page.title}\n\n${page.text}` : page.text,
                  // Mirror the web SourceReader: a fetched page is not the user's voice.
                  authoredByUser: false,
                  createdAt: anchor,
                },
              });
              await db.execute(sql`
                INSERT INTO job_execution (source_type, source_id, job_type)
                VALUES ('web', ${page.id}, ${INGESTION_PIPELINE_JOB_TYPE})
                ON CONFLICT DO NOTHING
              `);
            }
            // Advance to completion: verify → the LIVE brief.
            await engine.advance(runRow.id);
            const done = await skillRuns.getRun(principal, runRow.id);
            const steps = await skillRuns.steps(runRow.id);
            const brief = done?.brief ?? '';
            const citations = (done?.briefCitations ?? []) as {
              kind: string;
              memoryId?: string;
              url?: string;
              fetchedAt?: string;
            }[];
            const seededIds = new Set(seededRows.map((r) => r.id));
            const completed = done?.status === 'completed';
            const logComplete = steps.every(
              (s) => s.status === 'completed' || s.status === 'skipped',
            );
            const memoryCited =
              !testCase.skill.expect_memory_citation ||
              citations.some((c) => c.kind === 'memory' && seededIds.has(c.memoryId ?? ''));
            const webCited = citations.some((c) => c.kind === 'web' && !!c.url && !!c.fetchedAt);
            const included = testCase.skill.brief_must_include.every((sub) =>
              brief.toLowerCase().includes(sub.toLowerCase()),
            );
            const verifyLinks = steps.find((s) => s.stepKey === 'verify')?.links as
              { counts?: { contradicted?: number } } | undefined;
            const contradictionOk =
              !testCase.skill.expect_contradiction || (verifyLinks?.counts?.contradicted ?? 0) >= 1;
            const languageOk =
              !testCase.skill.language || checkLanguage(brief, testCase.skill.language);
            const removedOk = (await research.runsForSkill(runRow.id)).every(
              (r) => kept.some((k) => k.id === r.id) || r.status === 'cancelled',
            );
            skillOk =
              completed &&
              logComplete &&
              memoryCited &&
              webCited &&
              included &&
              contradictionOk &&
              languageOk &&
              removedOk;
            console.log(
              `  skill: completed=${String(completed)} log=${String(logComplete)} ` +
                `memoryCited=${String(memoryCited)} webCited=${String(webCited)} ` +
                `include=${String(included)} contradiction=${String(contradictionOk)} ` +
                `language=${String(languageOk)} removed=${String(removedOk)}` +
                `\n  brief: ${brief.slice(0, 220)}`,
            );
          }
        } catch (error) {
          console.log(
            `  skill flow FAILED: ${error instanceof Error ? error.message : String(error)}`,
          );
          skillOk = false;
        }
      }

      // Conversation checks — deterministic, folded like the
      // temporal set.
      const conversationChecks: (boolean | null)[] = [];
      if (checks.research_offer) {
        const runs = await db.execute<{ n: string }>(sql`
          SELECT count(*)::text AS n FROM research_run WHERE owner_id = ${principal.userId}
        `);
        const silentRuns = Number(runs.rows[0]?.n ?? '0');
        const offerOk = final.researchOffer && silentRuns === 0;
        conversationChecks.push(offerOk);
        console.log(
          `  research_offer: ${String(offerOk)} (offered=${String(final.researchOffer)}, runs=${silentRuns}: a knowledge question must offer, never silently search)`,
        );
      }
      if (checks.unsourced_required) {
        conversationChecks.push(/\{\{unsourced\}\}/.test(final.answer));
      }
      if (checks.smalltalk) {
        conversationChecks.push(
          final.sourceCount === 0 &&
            !/\{\{cite:/.test(final.answer) &&
            final.answer.trim().length > 0 &&
            !/don.?t have anything|nemam ništa/i.test(final.answer),
        );
      }
      if (checks.language) {
        const languageOk = checkLanguage(final.answer, checks.language);
        conversationChecks.push(languageOk);
        console.log(`  language(${checks.language}): ${String(languageOk)}`);
      }
      if (checks.digest_language) {
        // A REAL dreaming cycle over this case's seeded world, then the digest
        // in the case's preferred language.
        const { store: dreamStore, reconciliation } = createMemoryReconciliation({
          db,
          qdrant: { url: qdrantUrl, embeddingModel, collection },
        });
        const dreaming = new DreamingService(
          db,
          dreamStore,
          new ReconciliationService(gateway, dreamStore, reconciliation),
        );
        await dreaming.run();
        const digest = await buildDreamDigest(db, dreamStore, principal, {
          locale: checks.digest_language,
        });
        const joined = digest.lines.map((l) => l.text).join(' ');
        const digestOk = digest.lines.length > 0 && checkLanguage(joined, checks.digest_language);
        conversationChecks.push(digestOk);
        console.log(
          `  digest_language(${checks.digest_language}): ${String(digestOk)}, ${joined || '(no lines)'}`,
        );
      }
      const conversationOk =
        conversationChecks.length > 0 ? conversationChecks.every(Boolean) : null;

      const coverage = checks.coverage_facts
        ? await gradeCoverage(graderGateway, graderPrompt, final.answer, checks.coverage_facts)
        : null;
      if (coverage && coverage.missed.length > 0) {
        console.log(`  coverage misses: ${coverage.missed.join(' | ')}`);
      }
      // The temporal checks (all deterministic), folded into one verdict.
      const temporalChecks: (boolean | null)[] = [
        checks.must_include
          ? checks.must_include.every((s) => final.answer.toLowerCase().includes(s.toLowerCase()))
          : null,
        checks.must_exclude
          ? checks.must_exclude.every((s) => !final.answer.toLowerCase().includes(s.toLowerCase()))
          : null,
        checks.past_framing ? PAST_FRAMING_RE.test(stripCites(final.answer)) : null,
        checks.sources_status_includes
          ? checks.sources_status_includes.every((s) => final.sourceStatuses.includes(s))
          : null,
        checks.sources_status_excludes
          ? checks.sources_status_excludes.every((s) => !final.sourceStatuses.includes(s))
          : null,
      ];
      const temporalApplied = temporalChecks.filter((v) => v !== null);

      const score: CaseScore = {
        caseId: testCase.case_id,
        entityCorrect: checks.entity ? checkEntity(final.answer, checks.entity) : null,
        coverage: coverage ? coverage.fraction : null,
        coverageTarget: checks.coverage_target,
        hedgeMarked: checks.hedge ? checkHedge(final.answer, checks.hedge.term) : null,
        noMechanics: checks.no_mechanics ? checkNoMechanics(final.answer) : null,
        citationsValid: checks.citations_valid
          ? turns.every((t) => t.citationViolations === 0)
          : null,
        nothingOnRecord: checks.nothing_on_record ? checkNothingOnRecord(final.answer) : null,
        temporal: temporalApplied.length > 0 ? temporalApplied.every(Boolean) : null,
        research: researchOk,
        skill: skillOk,
        conversation: conversationOk,
        pass: false,
      };
      score.pass = [
        score.entityCorrect,
        score.coverage === null ? null : score.coverage >= score.coverageTarget,
        score.hedgeMarked,
        score.noMechanics,
        score.citationsValid,
        score.nothingOnRecord,
        score.temporal,
        score.research,
        score.skill,
        score.conversation,
      ]
        .filter((v) => v !== null)
        .every(Boolean);
      scores.push(score);
    }
  } finally {
    await pool.end();
    await Promise.all([pg.stop(), qdrant.stop()]);
  }

  const cell = (v: boolean | null): string => (v === null ? '' : v ? 'PASS' : 'FAIL');
  const cov = (s: CaseScore): string =>
    s.coverage === null ? '' : `${(s.coverage * 100).toFixed(0)}%`;
  const table = [
    '| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | research | skill | conversation | overall |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...scores.map(
      (s) =>
        `| ${s.caseId} | ${cell(s.entityCorrect)} | ${cov(s)} | ${cell(s.hedgeMarked)} | ` +
        `${cell(s.noMechanics)} | ${cell(s.citationsValid)} | ${cell(s.nothingOnRecord)} | ` +
        `${cell(s.temporal)} | ${cell(s.research)} | ` +
        `${cell(s.skill)} | ${cell(s.conversation)} | ${s.pass ? 'PASS' : 'FAIL'} |`,
    ),
  ].join('\n');

  const graderModel = (graderProviders ?? providers).tiers.answer;
  const versions =
    `configuration=${providers.id} · pipeline=${providers.tiers.pipeline.provider}/${providers.tiers.pipeline.model} · ` +
    `answer=${providers.tiers.answer.provider}/${providers.tiers.answer.model} · ` +
    `answer-prompt=${ANSWER_PROMPT.family}/${ANSWER_PROMPT.version} · ` +
    `grader=${graderModel.provider}/${graderModel.model} ${COVERAGE_PROMPT.family}/${COVERAGE_PROMPT.version}`;
  console.log('\n================ CHAT EVAL RESULTS ================');
  console.log(versions);
  console.log(table);
  console.log('==================================================\n');

  // The history file records MEASURED runs only; a cached replay measures the
  // harness, not the models (V2.0 item 3.4).
  if (cacheMode === 'replay') {
    console.log('cached replay: docs/eval/history.md not touched (it records live measurements)');
  } else {
    await mkdir(path.dirname(HISTORY_FILE), { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    await appendFile(HISTORY_FILE, `\n## ${stamp}, chat eval (${versions})\n\n${table}\n`, 'utf8');
    console.log(`appended to ${path.relative(REPO_ROOT, HISTORY_FILE)}`);
  }

  if (cacheMode === 'record' && cacheStore) {
    cacheStore.flush({
      scoring_version: EVAL_SCORING_VERSION,
      configuration_id: providers.id,
      models: {
        pipeline: providers.tiers.pipeline.model,
        answer: providers.tiers.answer.model,
        embedding: providers.tiers.embedding.model,
      },
      recorded_at: new Date().toISOString(),
    });
    console.log(
      `eval cache recorded: ${cacheStore.sizes.text} responses + ${cacheStore.sizes.embeddings} embeddings → ${path.relative(REPO_ROOT, CACHE_DIR)}`,
    );
  }

  // Trust-score emission (O7): --emit-json <path> merges the
  // chat summary into the partial `npm run eval -- --emit-json` started (order
  // does not matter; the file merges per configuration id). Emitted before the
  // gate check so a breach still records honest numbers.
  const emitIdx = process.argv.indexOf('--emit-json');
  const emitPath = emitIdx >= 0 ? process.argv[emitIdx + 1] : undefined;
  if (emitIdx >= 0 && !emitPath) {
    console.error('--emit-json requires a file path');
    process.exit(2);
  }
  if (emitPath) {
    // A cached replay must never become a published trust score (V2.0 3.4).
    if (cacheMode === 'replay') {
      console.error(
        'refusing --emit-json under COGETO_EVAL_CACHE=replay: trust scores are published ' +
          'from LIVE runs only. Re-run without the cache to emit.',
      );
      process.exit(2);
    }
    // The ACTIVE configuration, from the same resolver the gateway was built
    // with — id and models are exact by construction.
    const { id, models } = configurationForEmission(providers);
    emitPartial(emitPath, {
      schema_version: TRUST_SCORES_SCHEMA_VERSION,
      harness: `chat ${ANSWER_PROMPT.family}/${ANSWER_PROMPT.version} · grader ${COVERAGE_PROMPT.family}/${COVERAGE_PROMPT.version}`,
      configuration: {
        id,
        models,
        redaction: redaction !== undefined,
        corpus: { chat_cases: scores.length },
        metrics: {
          chat: {
            cases: scores.length,
            passed: scores.filter((s) => s.pass).length,
            failed: scores.filter((s) => !s.pass).map((s) => s.caseId),
          },
        },
      },
    });
    console.log(`trust-score partial (chat) emitted → ${emitPath}`);
  }

  // Gate mode: each signal gated by its reliability. The
  // rule-based checks (entity, hedge, no-mechanics, citations,
  // nothing-on-record, temporal) are deterministic and stay all-must-pass;
  // the LLM-judged coverage gates on the MEAN across coverage-graded cases
  // (per-case binary coverage flaked on judge noise). Per-case pass/fail is
  // still computed, printed, and published unchanged — only the CI verdict
  // arithmetic differs. Same switch as the golden-set gates.
  // A replay miss FAILS the run even when the caller swallowed the error
  // (`rewriteQuery` catches everything by design, so a missed rewrite would
  // otherwise degrade the run silently instead of failing it).
  if (cacheMode === 'replay' && cacheStore && cacheStore.misses > 0) {
    console.error(
      `eval cache: ${cacheStore.misses} MISS(ES). The fixtures do not cover this code. ` +
        `Refresh them with: npm run eval:cache:refresh`,
    );
    process.exitCode = 1;
  }

  if (process.env.COGETO_EVAL_GATE === '1') {
    const { chat_gates: chatGates } = z
      .object({ chat_gates: z.object({ mean_coverage: z.number().min(0).max(1) }) })
      .parse(JSON.parse(await readFile(GATES_FILE, 'utf8')));
    const rulesFailed = scores.filter((s) =>
      [
        s.entityCorrect,
        s.hedgeMarked,
        s.noMechanics,
        s.citationsValid,
        s.nothingOnRecord,
        s.temporal,
        s.research,
        s.skill,
        s.conversation,
      ].some((v) => v === false),
    );
    const covered = scores.filter((s) => s.coverage !== null);
    const meanCoverage =
      covered.length === 0
        ? 1
        : covered.reduce((sum, s) => sum + (s.coverage ?? 0), 0) / covered.length;
    console.log(
      `chat gate: rule checks ${rulesFailed.length === 0 ? 'all PASS' : `FAILED (${rulesFailed.map((s) => s.caseId).join(', ')})`} · ` +
        `mean coverage ${(meanCoverage * 100).toFixed(1)}% over ${covered.length} graded case(s) (gate ≥ ${(chatGates.mean_coverage * 100).toFixed(0)}%)`,
    );
    const breaches: string[] = [];
    if (rulesFailed.length > 0) {
      breaches.push(`rule check(s) failed: ${rulesFailed.map((s) => s.caseId).join(', ')}`);
    }
    if (meanCoverage < chatGates.mean_coverage) {
      breaches.push(
        `mean coverage ${(meanCoverage * 100).toFixed(1)}% below gate ${(chatGates.mean_coverage * 100).toFixed(0)}%`,
      );
    }
    if (breaches.length > 0) {
      console.error(`GATE BREACH: ${breaches.join('; ')}, failing the build`);
      process.exitCode = 1;
    }
  }
}

main().catch((error: unknown) => {
  console.error('eval:chat failed:', error);
  process.exit(1);
});
