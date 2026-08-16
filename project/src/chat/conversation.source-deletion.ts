import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { DbOrTx, Tx } from '../infrastructure/index';
import type { OwnedSourceRef, SourceCascade, SourceDeletion } from '../memory/index';
import { chatMessage, conversation } from './persistence/tables';

/**
 * The deletion saga's source port for source_type 'chat_conversation' (
 *, extending): deleting a conversation is
 * a SOURCE deletion through the spec §11.1 saga — never a chat route. The cascade
 * enumerates the conversation's messages as `chat` sub-sources, so every
 * memory derived from them (and its vector) joins the SAME enumeration
 * transaction and the ONE signed receipt; deleteSource then removes the
 * message rows and the conversation row itself. Archive is the safe
 * alternative — this path is for true erasure.
 */
@Injectable()
export class ConversationSourceDeletion implements SourceDeletion {
  readonly sourceType = 'chat_conversation' as const;

  async ownerOf(tx: Tx, sourceId: string): Promise<string | null> {
    const rows = await tx
      .select({ ownerId: conversation.ownerId })
      .from(conversation)
      .where(eq(conversation.id, sourceId))
      .for('update');
    return rows[0]?.ownerId ?? null;
  }

  /** Every message in the thread — the saga folds their chat-derived
   * memories into the enumeration and counts the messages on the receipt. */
  async enumerateCascade(tx: Tx, sourceId: string): Promise<SourceCascade> {
    const rows = await tx
      .select({ id: chatMessage.id })
      .from(chatMessage)
      .where(eq(chatMessage.conversationId, sourceId))
      .orderBy(asc(chatMessage.createdAt), asc(chatMessage.id));
    return { objectKeys: [], fileSubSourceKeys: [], chatSubSourceIds: rows.map((r) => r.id) };
  }

  async deleteSource(tx: Tx, sourceId: string): Promise<void> {
    // Messages first (the FK restricts otherwise), then the container.
    await tx.delete(chatMessage).where(eq(chatMessage.conversationId, sourceId));
    await tx.delete(conversation).where(eq(conversation.id, sourceId));
  }

  /**
   * Owner erasure's enumeration (issue #632): conversations, which are the
   * CONTAINERS. `ChatSourceDeletion` deliberately lists nothing, so a message
   * is reached exactly once, through the cascade above.
   *
   * `conversation` carries no scope column and needs none: a thread is the
   * owner's own side of a conversation with the instance and is never shown to
   * anyone else. Reporting `private` here is therefore the truth about the
   * container and not a default standing in for a missing value.
   *
   * That does NOT decide the outcome. A user can capture a fact from a chat
   * turn and share it, and the saga's guard sees that shared fact over the
   * conversation's whole enumeration and retains the entire thread — every
   * private message in it included. Keeping more than strictly necessary is
   * the direction the rule requires: the shared fact's provenance points at a
   * message inside this thread, so erasing the thread would erase the shared
   * fact with it.
   */
  async listForOwner(db: DbOrTx, ownerId: string): Promise<OwnedSourceRef[]> {
    const rows = await db
      .select({ sourceId: conversation.id })
      .from(conversation)
      .where(eq(conversation.ownerId, ownerId))
      .orderBy(asc(conversation.id));
    return rows.map((row) => ({ ...row, scope: 'private' as const }));
  }
}
