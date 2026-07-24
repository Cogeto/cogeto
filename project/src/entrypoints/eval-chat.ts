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
  ReconciliationService,
  seedMemoryFromSource,
} from '../ingestion/index';
import { TasksEngine } from '../tasks/index';
import { UserDirectory } from '../identity/index';
import { ANSWER_PROMPT, ChatService, RetrievalService } from '../retrieval/index';
import { ActionRegistry, ApprovalService } from '../agents/index';
import {
  ChatReplyResolver,
  ChatResearchResolver,
  EmailReplyDraftService,
  EmailSourceService,
  ResearchService,
  ResearchSynthesisService,
  WebDiscoveryService,
  WebFetchService,
} from '../connectors/index';
import type { ResearchOptions } from '../connectors/index';
import { DailyCounters } from '../infrastructure/index';
import { createModelGateway, loadPrompt, ModelGateway } from '../model-gateway/index';
import type { ResolvedModelProviders } from '../model-gateway/index';
import { resolveEvalProviders, requireConfiguredProviders } from './eval-env';
import { configurationForEmission, emitPartial, TRUST_SCORES_SCHEMA_VERSION } from './trust-scores';

/** The inbound address seeded emails are addressed to (chat reply-intent cases). */
const EVAL_INBOUND = 'capture@in.localhost';

/**
 * npm run eval:chat — the chat-answer eval suite (S3.5-A §2). It seeds a FRESH
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
const GATES_FILE = path.join(REPO_ROOT, 'project', 'eval', 'gates.json');
const HISTORY_FILE = path.join(REPO_ROOT, 'docs', 'eval', 'history.md');

const COVERAGE_PROMPT = { family: 'eval-coverage', version: 'v0001' } as const;

/**
 * Direct-fact seeding (F3-A): temporal cases need deterministic supersession
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
});

/** Seeded email_message rows (Session O4 — chat reply-intent cases). */
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
  /** Emails to seed for a draft-a-reply case (Session O4). */
  emails: z.array(emailSeedSchema).default([]),
  /**
   * Research cases (Priority 5 Part B): a scripted public web (discovery
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
  /** Per-case user context (P6.6, decision 0052): applied through the real
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
    /** Substrings the final answer must contain (temporal/tasks cases). */
    must_include: z.array(z.string()).optional(),
    /** Substrings the final answer must NOT contain (settled obligations). */
    must_exclude: z.array(z.string()).optional(),
    /** The answer must frame past belief as past (decision 0012 ruling 6). */
    past_framing: z.boolean().optional(),
    /** The final turn's sources must include / must not include these statuses. */
    sources_status_includes: z.array(z.string()).optional(),
    sources_status_excludes: z.array(z.string()).optional(),
    /**
     * Create-task cases (decision 0038): after the scripted turns, the harness
     * processes the chat capture through the real pipeline + task engine and
     * asserts EXACTLY ONE task was derived from a chat-sourced memory, with
     * these properties. Deterministic — part of the all-must-pass rule gate.
     */
    task_created: z
      .object({
        title_includes: z.array(z.string()).default([]),
        status: z.enum(['open', 'blocked_on_condition']).optional(),
        condition_includes: z.array(z.string()).default([]),
      })
      .optional(),
    /**
     * Conversation checks (decision 0046), folded into one deterministic
     * verdict like the temporal set:
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
     * Language checks (P6.6, decision 0052), folded into the conversation
     * verdict:
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
  /** Whether the done event carried the research offer (decision 0046). */
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
  /** The F3-A temporal checks folded into one verdict (null = not a temporal case). */
  temporal: boolean | null;
  /** The create-task verdict (decision 0038; null = not a create-task case). */
  taskCreated: boolean | null;
  /** The research-flow verdict (Part B; null = not a research case): gate →
   * approve → capture → cited synthesis → persisted web memories. */
  research: boolean | null;
  /** The folded conversation verdict (decision 0046; null = no such checks):
   * research offer without a silent search, unsourced marking, small talk. */
  conversation: boolean | null;
  pass: boolean;
}

/** Past framing: the answer talks about the past in en or hr. */
const PAST_FRAMING_RE =
  /\b(until|previously|used to|no longer|was|were|at the time|as of|before|earlier|since then|replaced|changed to|prije|do\s|više ne|bilo je|bila je|tada|od tada|zamijenjen)\b/i;

/**
 * The eval grader follows the answer tier unless overridden (decision 0040
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
 * Deterministic language judgment (P6.6): Croatian diacritics are a strong
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
  requireConfiguredProviders(providers, 'eval:chat');
  const gateway = createModelGateway({
    providers,
    redaction,
    // Deterministic sampling for comparable runs (decision 0035): stabilizes
    // both the answers under test and the coverage grader (where the provider
    // accepts a temperature — 0040 ruling 1).
    temperature: 0,
  });
  // Grader override (0040 ruling 3): a separate gateway ONLY for gradeCoverage.
  const graderProviders = graderProvidersFrom(providers);
  const graderGateway = graderProviders
    ? createModelGateway({ providers: graderProviders, redaction, temperature: 0 })
    : gateway;
  if (graderProviders) {
    console.log(
      `grader override: ${graderProviders.tiers.answer.provider}/${graderProviders.tiers.answer.model} ` +
        '(COGETO_PROVIDER_GRADER/COGETO_MODEL_GRADER) — note this when publishing',
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
      const tasksEngine = new TasksEngine(db, memoryStore, gateway);
      const retrieval = new RetrievalService(memoryStore, gateway, tasksEngine);
      // The chat → email-reply resolver (Session O4): draft-a-reply cases seed
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
      const evalPages = testCase.research?.pages ?? [];
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
        new DailyCounters(),
        { searchesMax: 100, pagesMax: 100, pagesPerRunMax: 8 },
        researchOptions,
        gateway,
        memoryStore,
      );
      const researchResolver = new ChatResearchResolver(research);
      // Per-case user context (P6.6): applied through the real service, so the
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
      const chat = new ChatService(
        db,
        retrieval,
        gateway,
        new UserDirectory(db),
        replyResolver,
        researchResolver,
        undefined,
        userContextService,
      );
      const anchor = new Date(testCase.anchor);

      // Seed emails (Session O4 reply-intent cases) directly — no public seed API.
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

      // Seed through the real pipeline, then run the task engine per source
      // (F3-B) — the worker's tasks.derive job, synchronously: derivation for
      // commitments, closure/condition judgments for later notes.
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
            createdAt: anchor,
          },
        });
        await db.transaction((tx) => tasksEngine.processSource(tx, 'user_note', sourceId));
      }
      // Direct-fact seeding (F3-A): fixed dates + real supersession mechanics.
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
      for (let i = 0; i < testCase.facts.length; i++) {
        await db.transaction((tx) =>
          tasksEngine.processSource(tx, 'user_note', `chat-eval-${testCase.case_id}-fact-${i}`),
        );
      }
      console.log(`  seeded ${testCase.notes.length} notes, ${testCase.facts.length} direct facts`);

      // Run the scripted conversation.
      const turns: TurnResult[] = [];
      for (const question of testCase.script) {
        let answer = '';
        let sourceCount = 0;
        let sourceStatuses: string[] = [];
        let citationViolations = 0;
        let researchOffer = false;
        for await (const event of chat.ask(principal, question) as AsyncIterable<ChatStreamEvent>) {
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

      // Create-task cases (decision 0038): the intent stored a normalized
      // capture on the user's message and enqueued the pipeline; the harness
      // stands in for the worker — run the real stages + task engine, then
      // assert on the derived task. A correctly refused (ambiguous/none) case
      // simply yields no capture and no task.
      let taskCreated: boolean | null = null;
      if (checks.task_created) {
        const captured = await db.execute<{ id: string; capture_content: string }>(sql`
          SELECT id, capture_content FROM chat_message
          WHERE owner_id = ${principal.userId} AND capture_content IS NOT NULL
        `);
        const chatMemoryIds = new Set<string>();
        for (const row of captured.rows) {
          await seedMemoryFromSource({
            db,
            gateway,
            memoryStore,
            source: {
              sourceType: 'chat',
              sourceId: row.id,
              ownerId: principal.userId,
              content: row.capture_content,
              createdAt: anchor,
            },
          });
          await db.transaction((tx) => tasksEngine.processSource(tx, 'chat', row.id));
          for (const m of await memoryStore.listBySourceSystem('chat', row.id)) {
            chatMemoryIds.add(m.id);
          }
        }
        const allTasks = await tasksEngine.listForPrincipal(principal, { includeSettled: true });
        const derived = allTasks.filter((t) => chatMemoryIds.has(t.derivedFromMemoryId));
        const wanted = checks.task_created;
        const one = derived.length === 1;
        const t = derived[0];
        const titleOk =
          !!t &&
          wanted.title_includes.every((s) => t.title.toLowerCase().includes(s.toLowerCase()));
        const statusOk = !wanted.status || t?.status === wanted.status;
        const conditionOk =
          wanted.condition_includes.length === 0 ||
          (!!t?.conditionText &&
            wanted.condition_includes.every((s) =>
              t.conditionText!.toLowerCase().includes(s.toLowerCase()),
            ));
        taskCreated = one && titleOk && statusOk && conditionOk;
        console.log(
          `  task_created: ${String(taskCreated)} (derived=${derived.length}` +
            (t ? `, status=${t.status}, waiting on: ${t.conditionText ?? '—'}` : '') +
            `)`,
        );
      }
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
            console.log(`  research: no proposed run after the chat turn — FAIL`);
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
                  createdAt: anchor,
                },
              });
              webMemories += (await memoryStore.listBySourceSystem('web', pageId)).length;
            }
            const synthesis = new ResearchSynthesisService(research, retrieval, gateway);
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

      // Conversation checks (decision 0046) — deterministic, folded like the
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
          `  research_offer: ${String(offerOk)} (offered=${String(final.researchOffer)}, runs=${silentRuns} — a knowledge question must offer, never silently search)`,
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
        // in the case's preferred language (decision 0052).
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
          `  digest_language(${checks.digest_language}): ${String(digestOk)} — ${joined || '(no lines)'}`,
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
      // The F3-A temporal checks (all deterministic), folded into one verdict.
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
        taskCreated,
        research: researchOk,
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
        score.taskCreated,
        score.research,
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

  const cell = (v: boolean | null): string => (v === null ? '—' : v ? 'PASS' : 'FAIL');
  const cov = (s: CaseScore): string =>
    s.coverage === null ? '—' : `${(s.coverage * 100).toFixed(0)}%`;
  const table = [
    '| case | entity | coverage | hedge | no-mechanics | citations | nothing | temporal | task | research | conversation | overall |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...scores.map(
      (s) =>
        `| ${s.caseId} | ${cell(s.entityCorrect)} | ${cov(s)} | ${cell(s.hedgeMarked)} | ` +
        `${cell(s.noMechanics)} | ${cell(s.citationsValid)} | ${cell(s.nothingOnRecord)} | ` +
        `${cell(s.temporal)} | ${cell(s.taskCreated)} | ${cell(s.research)} | ` +
        `${cell(s.conversation)} | ${s.pass ? 'PASS' : 'FAIL'} |`,
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

  await mkdir(path.dirname(HISTORY_FILE), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  await appendFile(HISTORY_FILE, `\n## ${stamp} — chat eval (${versions})\n\n${table}\n`, 'utf8');
  console.log(`appended to ${path.relative(REPO_ROOT, HISTORY_FILE)}`);

  // Trust-score emission (O7, decision 0032): --emit-json <path> merges the
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
    // The ACTIVE configuration, from the same resolver the gateway was built
    // with (decision 0040 ruling 5) — id and models are exact by construction.
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

  // Gate mode (decision 0036): each signal gated by its reliability. The
  // rule-based checks (entity, hedge, no-mechanics, citations,
  // nothing-on-record, temporal) are deterministic and stay all-must-pass;
  // the LLM-judged coverage gates on the MEAN across coverage-graded cases
  // (per-case binary coverage flaked on judge noise). Per-case pass/fail is
  // still computed, printed, and published unchanged — only the CI verdict
  // arithmetic differs. Same switch as the golden-set gates.
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
        s.taskCreated,
        s.research,
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
      console.error(`GATE BREACH: ${breaches.join('; ')} — failing the build`);
      process.exitCode = 1;
    }
  }
}

main().catch((error: unknown) => {
  console.error('eval:chat failed:', error);
  process.exit(1);
});
