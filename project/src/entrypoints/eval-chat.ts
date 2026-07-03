import 'reflect-metadata';
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { Pool } from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait } from 'testcontainers';
import type { ChatStreamEvent, Principal } from '@cogeto/shared';
import { applyMigrations, createDb } from '../infrastructure/index';
import { createMemoryStore } from '../memory/index';
import { seedMemoryFromSource } from '../ingestion/index';
import { ANSWER_PROMPT, ChatService, RetrievalService } from '../retrieval/index';
import { loadPrompt, MistralModelGateway } from '../model-gateway/index';

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
const HISTORY_FILE = path.join(REPO_ROOT, 'docs', 'eval', 'history.md');

const COVERAGE_PROMPT = { family: 'eval-coverage', version: 'v0001' } as const;

const caseSchema = z.object({
  case_id: z.string(),
  description: z.string().default(''),
  anchor: z.string(),
  notes: z.array(z.string()).min(1),
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
  citationViolations: number;
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
  pass: boolean;
}

async function resolveApiKey(): Promise<string | undefined> {
  const fromEnv = process.env.COGETO_MISTRAL_API_KEY || process.env.MISTRAL_API_KEY;
  if (fromEnv) return fromEnv;
  try {
    const dotenv = await readFile(path.join(REPO_ROOT, '.env'), 'utf8');
    const match = dotenv.match(/^(?:COGETO_)?MISTRAL_API_KEY=(.+)$/m);
    return match?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
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

function checkHedge(answer: string, term: string): boolean {
  if (!new RegExp(`\\b${term}\\b`, 'i').test(answer)) return true; // vacuous: not mentioned
  return /\buncertain|unconfirmed|not\s+(yet\s+)?confirmed|might|possibly|tentativ|wasn.?t\s+sure|may\s+prefer/i.test(
    answer,
  );
}

async function gradeCoverage(
  gateway: MistralModelGateway,
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
  const apiKey = await resolveApiKey();
  if (!apiKey) {
    console.error('eval:chat needs MISTRAL_API_KEY (env or repo-root .env) — the harness is live');
    process.exit(2);
  }
  const embedModel = process.env.COGETO_MISTRAL_EMBED_MODEL || process.env.MISTRAL_EMBED_MODEL;
  const pipelineModel =
    process.env.COGETO_MISTRAL_MODEL_PIPELINE || process.env.MISTRAL_MODEL_PIPELINE;
  const answerModel = process.env.COGETO_MISTRAL_MODEL_ANSWER || process.env.MISTRAL_MODEL_ANSWER;
  const gateway = new MistralModelGateway({ apiKey, pipelineModel, answerModel, embedModel });
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
      const retrieval = new RetrievalService(memoryStore, gateway);
      const chat = new ChatService(db, retrieval, gateway);
      const anchor = new Date(testCase.anchor);

      // Seed through the real pipeline.
      for (let i = 0; i < testCase.notes.length; i++) {
        await seedMemoryFromSource({
          db,
          gateway,
          memoryStore,
          source: {
            sourceType: 'user_note',
            sourceId: `chat-eval-${testCase.case_id}-${i}`,
            ownerId: principal.userId,
            content: testCase.notes[i]!,
            createdAt: anchor,
          },
        });
      }
      console.log(`  seeded ${testCase.notes.length} notes`);

      // Run the scripted conversation.
      const turns: TurnResult[] = [];
      for (const question of testCase.script) {
        let answer = '';
        let sourceCount = 0;
        let citationViolations = 0;
        for await (const event of chat.ask(principal, question) as AsyncIterable<ChatStreamEvent>) {
          if (event.type === 'sources') sourceCount = event.facts.length;
          else if (event.type === 'done') {
            answer = event.content;
            citationViolations = event.citationViolations;
          }
        }
        turns.push({ question, answer, sourceCount, citationViolations });
        console.log(
          `  Q: ${question}\n  A (${sourceCount} facts): ${stripCites(answer).slice(0, 220)}`,
        );
      }

      const final = turns[turns.length - 1]!;
      const checks = testCase.checks;
      const coverage = checks.coverage_facts
        ? await gradeCoverage(gateway, graderPrompt, final.answer, checks.coverage_facts)
        : null;
      if (coverage && coverage.missed.length > 0) {
        console.log(`  coverage misses: ${coverage.missed.join(' | ')}`);
      }
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
        pass: false,
      };
      score.pass = [
        score.entityCorrect,
        score.coverage === null ? null : score.coverage >= score.coverageTarget,
        score.hedgeMarked,
        score.noMechanics,
        score.citationsValid,
        score.nothingOnRecord,
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
    '| case | entity | coverage | hedge | no-mechanics | citations | nothing | overall |',
    '|---|---|---|---|---|---|---|---|',
    ...scores.map(
      (s) =>
        `| ${s.caseId} | ${cell(s.entityCorrect)} | ${cov(s)} | ${cell(s.hedgeMarked)} | ` +
        `${cell(s.noMechanics)} | ${cell(s.citationsValid)} | ${cell(s.nothingOnRecord)} | ` +
        `${s.pass ? 'PASS' : 'FAIL'} |`,
    ),
  ].join('\n');

  const versions = `pipeline=${pipelineModel ?? 'mistral-small-latest'} · answer=${answerModel ?? 'mistral-medium-latest'} · answer-prompt=${ANSWER_PROMPT.family}/${ANSWER_PROMPT.version} · grader=${COVERAGE_PROMPT.family}/${COVERAGE_PROMPT.version}`;
  console.log('\n================ CHAT EVAL RESULTS ================');
  console.log(versions);
  console.log(table);
  console.log('==================================================\n');

  await mkdir(path.dirname(HISTORY_FILE), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  await appendFile(HISTORY_FILE, `\n## ${stamp} — chat eval (${versions})\n\n${table}\n`, 'utf8');
  console.log(`appended to ${path.relative(REPO_ROOT, HISTORY_FILE)}`);
}

main().catch((error: unknown) => {
  console.error('eval:chat failed:', error);
  process.exit(1);
});
