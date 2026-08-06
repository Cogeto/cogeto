import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../infrastructure/index';
import { chatMessage, conversation } from './persistence/tables';

/**
 * The chat family's contributions to the Sources surface (V2.2 item 5.2),
 * as plain owner-scoped functions over the family's own tables.
 *
 * Chat captures have no listing of their own: which messages are SOURCES is
 * a fact about memory provenance, so the catalog enumerates them from the
 * memory side and only HYDRATES the display excerpt here.
 */

export interface SourceListingRow {
  sourceId: string;
  name: string;
  at: Date;
}

const NAME_CHARS = 96;

export async function hydrateChatSources(
  db: DbOrTx,
  ownerId: string,
  ids: readonly string[],
): Promise<Map<string, SourceListingRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: chatMessage.id, content: chatMessage.content, createdAt: chatMessage.createdAt })
    .from(chatMessage)
    .where(and(eq(chatMessage.ownerId, ownerId), inArray(chatMessage.id, [...ids])));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        sourceId: row.id,
        name: row.content.replace(/\s+/g, ' ').trim().slice(0, NAME_CHARS),
        at: row.createdAt,
      },
    ]),
  );
}

/** One answer that cited a memory (V2.2 item 5.2, the fact detail view). */
export interface CitingAnswerRow {
  messageId: string;
  conversationId: string;
  conversationTitle: string | null;
  createdAt: Date;
}

/**
 * The answers that cited one memory. The linkage IS the stored content:
 * every persisted assistant answer carries canonical `{{cite:<memoryId>}}`
 * tokens (the citation grammar), and the answer-redaction cascade erases them
 * with the cited memory, so this scan is complete for the canonical-token era
 * and can never point at erased evidence. Owner-scoped: answers live in the
 * asker's own conversations.
 */
export async function answersCiting(
  db: DbOrTx,
  ownerId: string,
  memoryId: string,
  options: { limit?: number } = {},
): Promise<CitingAnswerRow[]> {
  const token = `{{cite:${memoryId}}}`;
  const rows = await db
    .select({
      messageId: chatMessage.id,
      conversationId: chatMessage.conversationId,
      conversationTitle: conversation.title,
      createdAt: chatMessage.createdAt,
    })
    .from(chatMessage)
    .innerJoin(conversation, eq(chatMessage.conversationId, conversation.id))
    .where(
      and(
        eq(chatMessage.ownerId, ownerId),
        eq(chatMessage.role, 'assistant'),
        sql`position(${token} in ${chatMessage.content}) > 0`,
      ),
    )
    .orderBy(sql`${chatMessage.createdAt} DESC`)
    .limit(Math.min(options.limit ?? 20, 100));
  return rows;
}
