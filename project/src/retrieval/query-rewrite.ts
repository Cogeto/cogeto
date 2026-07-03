import { z } from 'zod';
import { loadPrompt, ModelGateway } from '../model-gateway/index';
import type { PromptArtifact } from '../model-gateway/index';
import { queryEntityCandidates } from './query-entities';
import { REWRITE_TIMEOUT_MS } from './retrieval-config';

/**
 * Conversational query rewriting (decision 0007 ruling 4; F3). One bounded
 * model call resolves pronouns/ellipsis in the latest turn against recent turns
 * into a self-contained query + entity list, so "who is she?" retrieves its
 * referent. Skipped for self-contained turns (cheap fast-path guard); on
 * timeout or error it falls back to the raw query.
 */
export const QUERY_REWRITE_PROMPT = { family: 'query_rewrite', version: 'v0001' } as const;

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface RewriteResult {
  query: string;
  /** Entities the query is about, from the rewriter or the heuristic fallback. */
  entities: string[];
}

const rewriteSchema = z.object({
  rewritten_query: z.string().min(1),
  entities: z.array(z.string()).default([]),
});

/** Third-person anaphora + demonstratives — first/second person needs no resolution. */
const ANAPHORA_RE =
  /\b(she|her|hers|he|him|his|it|its|they|them|their|theirs|this|that|these|those)\b/i;

/**
 * Rewrite only when the turn likely leans on context: it contains third-person
 * anaphora/demonstratives, or it is trivially short (a terse follow-up). A
 * self-contained, non-trivial question skips the call entirely.
 */
export function shouldRewrite(question: string): boolean {
  const words = question.trim().split(/\s+/).filter(Boolean);
  return words.length <= 3 || ANAPHORA_RE.test(question);
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
): Promise<RewriteResult> {
  const fallback: RewriteResult = { query: question, entities: queryEntityCandidates(question) };
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
    };
  } catch {
    return fallback;
  }
}
