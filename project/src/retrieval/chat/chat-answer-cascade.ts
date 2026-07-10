import { Injectable } from '@nestjs/common';
import { and, eq, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { Tx } from '../../infrastructure/index';
import type { DerivedCascade } from '../../memory/index';
import { chatMessage } from '../persistence/tables';

/**
 * The redaction marker an affected answer becomes. Deliberately a full
 * replacement, not an excision: an answer that quoted an erased fact cannot be
 * partially kept (the quote is woven into the prose), but the conversational
 * timeline must survive — the turn stays, its content does not.
 */
export const CHAT_ANSWER_REDACTED =
  'This answer referenced information that has since been deleted.';

/** LIKE-pattern batches: bounded OR fan-out per UPDATE statement. */
const IDS_PER_STATEMENT = 100;

/**
 * QS-7 (decision 0025): the deletion saga's DerivedCascade over chat answers.
 * A stored assistant message carries its citation linkage inline as canonical
 * `{{cite:<memory id>}}` tokens (decision 0007 ruling 2) — so any answer whose
 * stored text cites an erased memory is found by that token, INCLUDING every
 * historical answer, and redacted to a deletion marker inside the enumeration
 * transaction. Runs across owners deliberately: a peer's answer that quoted the
 * owner's shared fact quotes erased content all the same. The count lands in
 * the receipt (`counts_json.chat_messages_redacted`), so the receipt's claim
 * covers derived conversation content, not just rows/points/bytes.
 *
 * Idempotent by construction: redaction removes the cite tokens, so a later
 * deletion can never match (or double-count) an already-redacted answer.
 * User messages are never touched — they are the user's own words and remain
 * deletable as sources in their own right (decision 0021).
 */
@Injectable()
export class ChatAnswerCascade implements DerivedCascade {
  readonly artifact = 'chat_messages';

  async cascadeForMemories(tx: Tx, memoryIds: string[]): Promise<number> {
    let redacted = 0;
    for (let i = 0; i < memoryIds.length; i += IDS_PER_STATEMENT) {
      const batch = memoryIds.slice(i, i + IDS_PER_STATEMENT);
      const citeMatches: SQL[] = batch.map(
        (id) => sql`${chatMessage.content} LIKE ${`%{{cite:${id}}}%`}`,
      );
      const updated = await tx
        .update(chatMessage)
        .set({ content: CHAT_ANSWER_REDACTED })
        .where(and(eq(chatMessage.role, 'assistant'), or(...citeMatches)))
        .returning({ id: chatMessage.id });
      redacted += updated.length;
    }
    return redacted;
  }
}
