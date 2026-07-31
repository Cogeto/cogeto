import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { loadPrompt, ModelGateway } from '../model-gateway/index';
import {
  detectResearchIntent,
  detectSkillBriefIntent,
  detectSmallTalk,
  QUERY_REWRITE_PROMPT,
  rewriteQuery,
} from './query-rewrite';
import type { ConversationTurn } from './query-rewrite';

/**
 * Query-rewrite eval suite (V2.0 item 3.4; docs/eval-golden-set.md §5.1).
 *
 * The rewrite layer decides intent routing, pronoun resolution and temporal
 * classification on EVERY chat turn, and until now it was measured only
 * indirectly: a downstream answer assertion fails for many reasons, and a
 * mis-route shows up as "the answer was wrong" rather than "the router sent
 * this to the wrong place". These cases assert the routing decision itself.
 *
 * The suite runs the REAL decision path — `rewriteQuery` with
 * `alwaysClassify` (what the chat router uses) plus the deterministic
 * detectors the router consults beside it — against the live gateway, and
 * scores per case, all-assertions-must-hold. Every case asserts the full
 * intent shape: an expectation omitted from the file means "must be null", so
 * a case authored for pronoun resolution also carries negative coverage for
 * every intent it is not.
 */

const turnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
});

const expectSchema = z.object({
  /**
   * Omitted (null) means "not asserted", and is legal ONLY on a turn where a
   * deterministic detector pre-empts the router: `ChatService` checks small
   * talk, then the skill brief, then research BEFORE it ever calls the
   * rewriter, so a class on those turns would assert a value nothing reads.
   */
  question_class: z.enum(['personal', 'knowledge', 'smalltalk']).nullable().default(null),
  /** Substrings the rewritten query must contain (pronoun/ellipsis resolution). */
  query_must_include: z.array(z.string()).default([]),
  /** Substrings the rewritten query must NOT contain (an unresolved pronoun). */
  query_must_exclude: z.array(z.string()).default([]),
  /** Entities the rewriter must surface. */
  entities_must_include: z.array(z.string()).default([]),
  /** null (or omitted) asserts NO temporal intent — the negative cases. */
  temporal: z
    .object({
      kind: z.enum(['previous', 'point_in_time', 'change_since']),
      /** Resolved instant as YYYY-MM-DD; omitted for `previous`. */
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    })
    .nullable()
    .default(null),
  /** null (or omitted) asserts NO open-loops intent. */
  open_loops: z
    .object({ entity: z.string().nullable().default(null) })
    .nullable()
    .default(null),
  /** null (or omitted) asserts NO draft-a-reply intent. */
  email_reply: z
    .object({ target: z.string().nullable().default(null) })
    .nullable()
    .default(null),
  /** Deterministic detectors the chat router consults beside the rewriter. */
  research: z.object({ topic: z.string() }).nullable().default(null),
  skill_brief: z.object({ subject: z.string() }).nullable().default(null),
  small_talk: z
    .object({ kind: z.enum(['thanks', 'greeting', 'farewell', 'ack']) })
    .nullable()
    .default(null),
});

/** True when a deterministic detector short-circuits before the rewriter. */
export function preemptsRouter(expect: z.infer<typeof expectSchema>): boolean {
  return Boolean(expect.small_talk ?? expect.skill_brief ?? expect.research);
}

export const rewriteCaseSchema = z
  .object({
    case_id: z.string(),
    /** The anchor "now" — pins relative-date cases to a fixed instant forever. */
    now: z.string(),
    history: z.array(turnSchema).default([]),
    question: z.string().min(1),
    expect: expectSchema,
    notes: z.string().optional(),
  })
  .refine((c) => preemptsRouter(c.expect) || c.expect.question_class !== null, {
    message:
      'question_class is required unless a deterministic detector (small_talk / skill_brief / research) pre-empts the router',
    path: ['expect', 'question_class'],
  })
  .refine((c) => !preemptsRouter(c.expect) || c.expect.question_class === null, {
    message:
      'question_class must be omitted on a turn a deterministic detector pre-empts: the router never reads it there',
    path: ['expect', 'question_class'],
  });
export type RewriteCase = z.infer<typeof rewriteCaseSchema>;

export interface RewriteEvalMetrics {
  label: string;
  cases: number;
  passed: number;
  accuracy: number;
}

export interface RewriteEvalResult {
  perLanguage: RewriteEvalMetrics[];
  aggregate: RewriteEvalMetrics;
  caseCount: number;
  promptVersion: string;
  /** Per-case failure detail, for the run log and the pull-request body. */
  failures: { caseId: string; reasons: string[] }[];
}

interface LoadedRewriteCase {
  lang: string;
  rewriteCase: RewriteCase;
}

export async function loadRewriteCases(casesDir: string): Promise<LoadedRewriteCase[]> {
  const loaded: LoadedRewriteCase[] = [];
  const langs = (await readdir(casesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const lang of langs) {
    const files = (await readdir(path.join(casesDir, lang)))
      .filter((file) => file.endsWith('.json'))
      .sort();
    for (const file of files) {
      const raw = JSON.parse(await readFile(path.join(casesDir, lang, file), 'utf8'));
      loaded.push({ lang, rewriteCase: rewriteCaseSchema.parse(raw) });
    }
  }
  return loaded;
}

const day = (value: Date): string => value.toISOString().slice(0, 10);

/**
 * Every assertion a case makes, evaluated against one real routing decision.
 * `rewrite` is absent on turns a deterministic detector pre-empts — exactly as
 * in `ChatService`, which returns before the router call on those turns.
 */
export function scoreRewriteCase(
  rewriteCase: RewriteCase,
  actual: {
    research: { topic: string } | null;
    skillBrief: { subject: string } | null;
    smallTalk: { kind: string } | null;
    rewrite: {
      query: string;
      entities: string[];
      questionClass: string;
      temporal: { kind: string; at?: Date; since?: Date } | null;
      openLoops: { entity: string | null } | null;
      emailReply: { target: string | null } | null;
    } | null;
  },
): string[] {
  const reasons: string[] = [];
  const expect = rewriteCase.expect;

  // The deterministic detectors, always asserted and always in full: a case
  // authored for research also proves the brief and small-talk detectors kept
  // their hands off it.
  if (!expect.research) {
    if (actual.research) reasons.push(`research "${actual.research.topic}" expected none`);
  } else if (!actual.research) {
    reasons.push('research none, expected a research intent');
  } else if (actual.research.topic !== expect.research.topic) {
    reasons.push(`research topic "${actual.research.topic}" != "${expect.research.topic}"`);
  }

  if (!expect.skill_brief) {
    if (actual.skillBrief) reasons.push(`skill_brief "${actual.skillBrief.subject}" expected none`);
  } else if (!actual.skillBrief) {
    reasons.push('skill_brief none, expected a brief intent');
  } else if (actual.skillBrief.subject !== expect.skill_brief.subject) {
    reasons.push(
      `skill_brief subject "${actual.skillBrief.subject}" != "${expect.skill_brief.subject}"`,
    );
  }

  if (!expect.small_talk) {
    if (actual.smallTalk) reasons.push(`small_talk ${actual.smallTalk.kind} expected none`);
  } else if (!actual.smallTalk) {
    reasons.push(`small_talk none, expected ${expect.small_talk.kind}`);
  } else if (actual.smallTalk.kind !== expect.small_talk.kind) {
    reasons.push(`small_talk ${actual.smallTalk.kind} != ${expect.small_talk.kind}`);
  }

  // The rewriter half runs only where the router runs it.
  if (!actual.rewrite) return reasons;
  const query = actual.rewrite.query.toLowerCase();

  if (expect.question_class !== null && actual.rewrite.questionClass !== expect.question_class) {
    reasons.push(`question_class ${actual.rewrite.questionClass} != ${expect.question_class}`);
  }
  for (const needle of expect.query_must_include) {
    if (!query.includes(needle.toLowerCase())) reasons.push(`query missing "${needle}"`);
  }
  for (const needle of expect.query_must_exclude) {
    if (query.includes(needle.toLowerCase())) reasons.push(`query still carries "${needle}"`);
  }
  const entities = actual.rewrite.entities.join(' ').toLowerCase();
  for (const needle of expect.entities_must_include) {
    if (!entities.includes(needle.toLowerCase())) reasons.push(`entities missing "${needle}"`);
  }

  // Temporal: kind AND the deterministically resolved instant. An expectation
  // of null asserts the veto guard held.
  const temporal = actual.rewrite.temporal;
  if (!expect.temporal) {
    if (temporal) reasons.push(`temporal ${temporal.kind} expected none`);
  } else if (!temporal) {
    reasons.push(`temporal none, expected ${expect.temporal.kind}`);
  } else {
    if (temporal.kind !== expect.temporal.kind) {
      reasons.push(`temporal ${temporal.kind} != ${expect.temporal.kind}`);
    }
    if (expect.temporal.date) {
      const resolved = temporal.at ?? temporal.since;
      const got = resolved ? day(resolved) : 'unresolved';
      if (got !== expect.temporal.date) {
        reasons.push(`temporal date ${got} != ${expect.temporal.date}`);
      }
    }
  }

  const openLoops = actual.rewrite.openLoops;
  if (!expect.open_loops) {
    if (openLoops) reasons.push('open_loops set, expected none');
  } else if (!openLoops) {
    reasons.push('open_loops none, expected an open-loops intent');
  } else if ((openLoops.entity ?? null) !== (expect.open_loops.entity ?? null)) {
    reasons.push(
      `open_loops entity ${String(openLoops.entity)} != ${String(expect.open_loops.entity)}`,
    );
  }

  const emailReply = actual.rewrite.emailReply;
  if (!expect.email_reply) {
    if (emailReply) reasons.push('email_reply set, expected none');
  } else if (!emailReply) {
    reasons.push('email_reply none, expected a reply intent');
  } else if ((emailReply.target ?? null) !== (expect.email_reply.target ?? null)) {
    reasons.push(
      `email_reply target ${String(emailReply.target)} != ${String(expect.email_reply.target)}`,
    );
  }

  return reasons;
}

function emptyMetrics(label: string): RewriteEvalMetrics {
  return { label, cases: 0, passed: 0, accuracy: 1 };
}

export async function runRewriteEval(options: {
  gateway: ModelGateway;
  casesDir: string;
  log?: (message: string) => void;
}): Promise<RewriteEvalResult> {
  const log = options.log ?? (() => undefined);
  const cases = await loadRewriteCases(options.casesDir);
  const byLang = new Map<string, RewriteEvalMetrics>();
  const aggregate = emptyMetrics('aggregate');
  const failures: RewriteEvalResult['failures'] = [];

  for (const { lang, rewriteCase } of cases) {
    const metrics = byLang.get(lang) ?? emptyMetrics(lang);
    byLang.set(lang, metrics);
    const history: ConversationTurn[] = rewriteCase.history;
    let reasons: string[];
    try {
      // The router's own order: the deterministic detectors first, and the
      // model call ONLY on turns none of them claimed.
      const detected = {
        research: detectResearchIntent(rewriteCase.question),
        skillBrief: detectSkillBriefIntent(rewriteCase.question),
        smallTalk: detectSmallTalk(rewriteCase.question),
      };
      const preempted = Boolean(detected.smallTalk ?? detected.skillBrief ?? detected.research);
      const result =
        preempted && preemptsRouter(rewriteCase.expect)
          ? null
          : await rewriteQuery(
              options.gateway,
              history,
              rewriteCase.question,
              loadPrompt,
              new Date(rewriteCase.now),
              undefined,
              // What the chat router asks for: the question class is needed on
              // every turn, including ones the cheap lexical gate would skip.
              { alwaysClassify: true },
            );
      reasons = scoreRewriteCase(rewriteCase, {
        ...detected,
        rewrite: result
          ? {
              query: result.query,
              entities: result.entities,
              questionClass: result.questionClass,
              temporal: result.temporal,
              openLoops: result.openLoops,
              emailReply: result.emailReply,
            }
          : null,
      });
    } catch (error) {
      // `rewriteQuery` swallows its own failures into the safe fallback, so
      // reaching here means the harness itself broke. Score it as a miss
      // rather than aborting the run.
      reasons = [`CASE FAILED (${error instanceof Error ? error.message : String(error)})`];
    }

    metrics.cases += 1;
    aggregate.cases += 1;
    if (reasons.length === 0) {
      metrics.passed += 1;
      aggregate.passed += 1;
      log(`${rewriteCase.case_id}: PASS`);
    } else {
      failures.push({ caseId: rewriteCase.case_id, reasons });
      log(`${rewriteCase.case_id}: FAIL: ${reasons.join('; ')}`);
    }
  }

  const finalize = (m: RewriteEvalMetrics): RewriteEvalMetrics => {
    m.accuracy = m.cases === 0 ? 1 : m.passed / m.cases;
    return m;
  };
  return {
    perLanguage: [...byLang.values()].map(finalize).sort((a, b) => a.label.localeCompare(b.label)),
    aggregate: finalize(aggregate),
    caseCount: cases.length,
    promptVersion: `${QUERY_REWRITE_PROMPT.family}/${QUERY_REWRITE_PROMPT.version}`,
    failures,
  };
}
