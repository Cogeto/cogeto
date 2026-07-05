import { z } from 'zod';
import { resolveExpression } from '../ingestion/index';
import { loadPrompt, ModelGateway } from '../model-gateway/index';
import type { PromptArtifact } from '../model-gateway/index';
import { queryEntityCandidates } from './query-entities';
import { REWRITE_TIMEOUT_MS } from './retrieval-config';

/**
 * Conversational query rewriting (decision 0007 ruling 4; F3) + temporal
 * intent (decision 0012 ruling 2; F3-A). One bounded model call resolves
 * pronouns/ellipsis into a self-contained query and classifies temporal
 * intent — but temporal is DOUBLE-GUARDED deterministically: the model is
 * consulted for it only when the raw question carries a temporal hint, and a
 * classification without a hint is discarded. Dates are resolved by the S3.5
 * chrono resolver, never by the model. Any failure → default mode, never an
 * error.
 */
export const QUERY_REWRITE_PROMPT = { family: 'query_rewrite', version: 'v0003' } as const;

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type TemporalIntentKind = 'previous' | 'point_in_time' | 'change_since';

export interface TemporalIntent {
  kind: TemporalIntentKind;
  /** Resolved instant for point_in_time (deterministic, chrono-anchored to now). */
  at?: Date;
  /** Resolved window start for change_since. */
  since?: Date;
}

export interface OpenLoopsIntent {
  /** Entity-scoped variant ("what's open with Luka"); null = everything open. */
  entity: string | null;
}

export interface RewriteResult {
  query: string;
  /** Entities the query is about, from the rewriter or the heuristic fallback. */
  entities: string[];
  /** Temporal intent (decision 0012 ruling 2); null = default retrieval. */
  temporal: TemporalIntent | null;
  /** Open-loops intent (decision 0013 ruling 7); null = default retrieval. */
  openLoops: OpenLoopsIntent | null;
}

const rewriteSchema = z.object({
  rewritten_query: z.string().min(1),
  entities: z.array(z.string()).default([]),
  temporal: z
    .object({
      kind: z.enum(['previous', 'point_in_time', 'change_since']),
      /** The temporal phrase VERBATIM ("in March", "od lipnja") — code resolves it. */
      expression: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  open_loops: z
    .object({ entity: z.string().nullable().default(null) })
    .nullable()
    .default(null),
});

/** Third-person anaphora + demonstratives — first/second person needs no resolution. */
const ANAPHORA_RE =
  /\b(she|her|hers|he|him|his|it|its|they|them|their|theirs|this|that|these|those)\b/i;

/**
 * The temporal-hint lexicon (decision 0012 ruling 2), en + hr: the enable AND
 * veto guard. Plain questions can never classify temporal — a model claim
 * without a hint in the RAW question is discarded.
 */
export const TEMPORAL_HINT_RE = new RegExp(
  [
    // English
    'previous(ly)?',
    'used to',
    'before',
    'back then',
    'earlier',
    'at the time',
    'originally',
    'history of',
    "what(’|')?s? (has )?changed",
    'what is new since',
    "what('|’)s new",
    'since\\s+(january|february|march|april|may|june|july|august|september|october|november|december|last|\\d)',
    '\\bin\\s+(january|february|march|april|may|june|july|august|september|october|november|december)\\b',
    'last (year|month|quarter|week)',
    // Croatian
    'prije',
    'prošl\\w*',
    'nekad',
    'ranije',
    'u to (vrijeme|doba)',
    'izvorno',
    'što se promijenilo',
    'što je novo',
    'od (siječnja|veljače|ožujka|travnja|svibnja|lipnja|srpnja|kolovoza|rujna|listopada|studenog|prosinca)',
    'u (siječnju|veljači|ožujku|travnju|svibnju|lipnju|srpnju|kolovozu|rujnu|listopadu|studenom|prosincu)',
  ].join('|'),
  'i',
);

/**
 * The open-loops hint lexicon (decision 0013 ruling 7), en + hr — the same
 * enable-and-veto double guard as temporal.
 */
export const OPEN_LOOPS_HINT_RE = new RegExp(
  [
    // English
    'still open',
    'outstanding',
    'pending',
    'waiting (on|for)',
    'open (loops?|items?|tasks?)',
    "what('|’)?s open",
    'what is open',
    'did i promise',
    'do i (still )?owe',
    'commit(ted)? to',
    'follow[- ]ups?',
    'to[- ]dos?',
    // Croatian
    'još otvoreno',
    'otvoren\\w*',
    'neriješen\\w*',
    'čeka\\w*',
    'obeć\\w*',
    'dugujem',
    'obvez\\w*',
    'zadaci|zadatke|zadataka',
  ].join('|'),
  'i',
);

/**
 * Rewrite when the turn leans on context (anaphora / terse follow-up) OR
 * carries a temporal or open-loops hint — intent classification needs the
 * model even for otherwise self-contained questions.
 */
export function shouldRewrite(question: string): boolean {
  const words = question.trim().split(/\s+/).filter(Boolean);
  return (
    words.length <= 3 ||
    ANAPHORA_RE.test(question) ||
    TEMPORAL_HINT_RE.test(question) ||
    OPEN_LOOPS_HINT_RE.test(question)
  );
}

/** The open-loops veto guard: no hint in the raw question, no tasks mode. */
export function resolveOpenLoopsIntent(
  rawQuestion: string,
  claimed: { entity: string | null } | null,
): OpenLoopsIntent | null {
  if (!claimed) return null;
  if (!OPEN_LOOPS_HINT_RE.test(rawQuestion)) return null;
  const entity = claimed.entity?.trim() || null;
  return { entity };
}

/**
 * Deterministic resolution of the model's classification (ruling 2): the veto
 * guard, then chrono for dates. point_in_time without a resolvable date and
 * change_since without a resolvable start both fall back to default mode.
 */
export function resolveTemporalIntent(
  rawQuestion: string,
  claimed: { kind: TemporalIntentKind; expression: string | null } | null,
  now: Date = new Date(),
): TemporalIntent | null {
  if (!claimed) return null;
  if (!TEMPORAL_HINT_RE.test(rawQuestion)) return null; // veto: no hint, no mode
  if (claimed.kind === 'previous') return { kind: 'previous' };
  const raw = claimed.expression ? resolveExpression(claimed.expression, now) : null;
  const resolved = raw ? toMostRecentPast(raw, now) : null;
  if (!resolved) return null; // unresolvable date → default mode, never an error
  return claimed.kind === 'point_in_time'
    ? { kind: 'point_in_time', at: resolved }
    : { kind: 'change_since', since: resolved };
}

/**
 * The S3.5 resolver prefers FORWARD dates (it was built for deadlines — "by
 * Monday"); temporal queries look BACKWARD ("in March" asked in July means
 * last March). Policy, not a second date engine: a future resolution steps
 * back one year; still future → unresolvable.
 */
function toMostRecentPast(resolved: Date, now: Date): Date | null {
  if (resolved.getTime() <= now.getTime()) return resolved;
  const stepped = new Date(resolved);
  stepped.setFullYear(stepped.getFullYear() - 1);
  return stepped.getTime() <= now.getTime() ? stepped : null;
}

function buildRewriteInput(history: ConversationTurn[], question: string): string {
  const turns = history.length
    ? history.map((t) => `${t.role}: ${t.content}`).join('\n')
    : '(none)';
  return ['RECENT TURNS:', turns, '', 'QUESTION:', question].join('\n');
}

/**
 * Returns a self-contained query + entities. Uses the model when the turn needs
 * it; otherwise (and on any failure/timeout) falls back to the raw query with
 * heuristic entity candidates — the fast path never blocks on the rewriter.
 */
export async function rewriteQuery(
  gateway: ModelGateway,
  history: ConversationTurn[],
  question: string,
  loadPromptFn: typeof loadPrompt = loadPrompt,
  now: Date = new Date(),
): Promise<RewriteResult> {
  const fallback: RewriteResult = {
    query: question,
    entities: queryEntityCandidates(question),
    temporal: null,
    openLoops: null,
  };
  if (!shouldRewrite(question)) return fallback;

  try {
    const prompt: PromptArtifact = await loadPromptFn(
      QUERY_REWRITE_PROMPT.family,
      QUERY_REWRITE_PROMPT.version,
    );
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), REWRITE_TIMEOUT_MS),
    );
    const call = gateway.extractStructured(rewriteSchema, {
      system: prompt.content,
      input: buildRewriteInput(history, question),
      tier: 'pipeline',
    });
    const result = await Promise.race([call, timeout]);
    if (!result) return fallback; // timed out
    const entities = result.entities.map((e) => e.trim()).filter(Boolean);
    return {
      query: result.rewritten_query.trim() || question,
      entities: entities.length > 0 ? entities : queryEntityCandidates(result.rewritten_query),
      // Veto guard + deterministic date resolution (decision 0012 ruling 2).
      temporal: resolveTemporalIntent(question, result.temporal, now),
      openLoops: resolveOpenLoopsIntent(question, result.open_loops),
    };
  } catch {
    return fallback;
  }
}
