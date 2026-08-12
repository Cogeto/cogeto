import { sql } from 'drizzle-orm';
import { CITATION_STRIP_SQL_PATTERN } from '@cogeto/shared';
import type { Db } from '../infrastructure/index';

/**
 * Conversation search (issue #530): find a thread by what was SAID in it, not
 * only by the two-to-six words a model chose to title it with.
 *
 * The same full-text construction `MemoryStore.ftsSearch` uses, so search
 * behaves here the way the fact search users already know behaves:
 * `websearch_to_tsquery` over an accent-folded `simple` vector, ranked by
 * `ts_rank_cd`. Two arms, because the two things being matched are shaped
 * differently:
 *
 *  - **messages** hit the GIN index on the generated `content_tsv` column
 *    (migration 0057), and collapse to the BEST message per conversation:
 *    a thread that says "tolerance" nine times is one result, not nine;
 *  - **titles** build their vector on the fly. A user has at most a few
 *    hundred conversations, so this is a keyed owner-scoped scan, and an
 *    index there would cost storage to save nothing measurable.
 *
 * Owner scoping is the WHERE clause in both arms, exactly like every other
 * chat read. There is no scope or sensitivity gate to apply: a conversation
 * is its owner's alone.
 */

/** Bounds the result set; searching is for finding one thread, not browsing. */
export const SEARCH_LIMIT = 30;

/**
 * Sentinels for `ts_headline`, chosen because the SPA splits on them to render
 * the highlight rather than being handed HTML to inject. Control characters
 * cannot survive a round trip through the composer, and any that somehow exist
 * in stored content are stripped from the headline input below, so a sentinel
 * in the output always means "this is the match".
 */
export const MATCH_OPEN = '\u0001';
export const MATCH_CLOSE = '\u0002';

export interface ConversationSearchRow {
  conversationId: string;
  /** The best-matching message, when the hit came from message text. */
  messageId: string | null;
  /** That message with the matched words wrapped in the sentinels; null when
   * only the title matched, where the title is the whole answer already. */
  snippet: string | null;
  /** Higher is better. Message rank, or a fixed floor for a title-only hit. */
  score: number;
  matchedTitle: boolean;
}

/**
 * A title match ranks above an unremarkable message match: naming a thread is
 * a stronger signal about what it IS than one line inside it. `ts_rank_cd`
 * with normalization 32 returns values in [0,1), so this sits near the top
 * without ever pinning a title hit above a genuinely dense message match.
 */
const TITLE_SCORE = 0.5;

export async function searchConversations(
  db: Db,
  ownerId: string,
  query: string,
  limit: number = SEARCH_LIMIT,
): Promise<ConversationSearchRow[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const tsQuery = sql`websearch_to_tsquery('simple', cogeto_unaccent(${trimmed}))`;

  // DISTINCT ON collapses each conversation to its best-scoring message, so
  // the result list is conversations rather than messages.
  const messageHits = await db.execute(sql`
    SELECT DISTINCT ON (conversation_id)
      conversation_id,
      id AS message_id,
      ts_rank_cd(content_tsv, ${tsQuery}, 32) AS score,
      ts_headline(
        'simple',
        -- Citation tokens are renderer instruction, never reading text: a
        -- snippet showing a cite token is leaking internals at the user
        -- (issue #530 follow-up). Stripped BEFORE the headline so the window
        -- spends its words on the sentence rather than on a uuid. The pattern
        -- is a bound parameter, never interpolated SQL.
        regexp_replace(
          replace(replace(content, chr(1), ''), chr(2), ''),
          ${CITATION_STRIP_SQL_PATTERN},
          '',
          'g'
        ),
        ${tsQuery},
        'StartSel=' || chr(1) || ', StopSel=' || chr(2) ||
        ', MaxWords=28, MinWords=12, ShortWord=2, MaxFragments=1'
      ) AS snippet
    FROM chat_message
    WHERE owner_id = ${ownerId} AND content_tsv @@ ${tsQuery}
    ORDER BY conversation_id, score DESC, created_at DESC, id DESC
  `);

  const titleHits = await db.execute(sql`
    SELECT id AS conversation_id
    FROM conversation
    WHERE owner_id = ${ownerId}
      AND title IS NOT NULL
      AND to_tsvector('simple', cogeto_unaccent(title)) @@ ${tsQuery}
  `);

  const byConversation = new Map<string, ConversationSearchRow>();
  for (const row of messageHits.rows as {
    conversation_id: string;
    message_id: string;
    score: number;
    snippet: string | null;
  }[]) {
    byConversation.set(row.conversation_id, {
      conversationId: row.conversation_id,
      messageId: row.message_id,
      snippet: row.snippet,
      score: Number(row.score),
      matchedTitle: false,
    });
  }
  for (const row of titleHits.rows as { conversation_id: string }[]) {
    const existing = byConversation.get(row.conversation_id);
    if (existing) {
      // Matched both: keep the message snippet as the evidence, and let the
      // title match lift the score, because it agreed.
      existing.matchedTitle = true;
      existing.score = Math.max(existing.score, TITLE_SCORE) + TITLE_SCORE;
      continue;
    }
    byConversation.set(row.conversation_id, {
      conversationId: row.conversation_id,
      messageId: null,
      snippet: null,
      score: TITLE_SCORE,
      matchedTitle: true,
    });
  }

  return [...byConversation.values()]
    .sort((a, b) => b.score - a.score || a.conversationId.localeCompare(b.conversationId))
    .slice(0, limit);
}
