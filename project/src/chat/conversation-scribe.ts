import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { chatMessage, conversation } from './persistence/tables';

/**
 * The conversation-append seam. Retrieval owns
 * the chat tables, so it owns BOTH the port and the implementation; the
 * research side (connectors) injects the token @Optional and never touches a
 * chat table (spec §15 rule 2). Used to land a concluded research answer in the
 * conversation it was invoked from — as a persistent assistant message.
 */
export const CONVERSATION_APPEND = Symbol('CONVERSATION_APPEND');

export interface ConversationAppendPort {
  /** Appends an assistant message; skips silently (false) when the
   * conversation is gone or owned by someone else. */
  append(ownerId: string, conversationId: string, content: string): Promise<boolean>;
}

/** Strips every {{…}} token EXCEPT the canonical {{cite:<uuid>}} form — the
 * one token the chat renderer accepts (the stored-answer sanitize rule). */
const NON_CITE_TOKEN_RE = /\{\{(?!cite:[0-9a-f-]{36}\}\})[^}]*\}\}/g;

@Injectable()
export class ConversationScribe implements ConversationAppendPort {
  private readonly logger = new Logger(ConversationScribe.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async append(ownerId: string, conversationId: string, content: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: conversation.id })
      .from(conversation)
      .where(and(eq(conversation.id, conversationId), eq(conversation.ownerId, ownerId)))
      .limit(1);
    if (rows.length === 0) {
      // The conversation was deleted (or never the caller's) — the answer
      // stays on its run; nothing to do here. Metadata only (pino rule).
      this.logger.warn(`conversation_append_skipped: conversation missing or foreign`);
      return false;
    }
    // The stored-message grammar: valid {{cite:<uuid>}} tokens pass; any other
    // {{…}} token is stripped so the renderer can never meet an unknown form.
    const sanitized = content.replace(NON_CITE_TOKEN_RE, '').replace(/[ \t]{2,}/g, ' ');
    const [row] = await this.db
      .insert(chatMessage)
      .values({ ownerId, conversationId, role: 'assistant', content: sanitized })
      .returning();
    await this.db
      .update(conversation)
      .set({ updatedAt: row!.createdAt })
      .where(eq(conversation.id, conversationId));
    return true;
  }
}
