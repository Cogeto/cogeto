import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Tx } from '../infrastructure/index';
import type { OwnedSourceRef, SourceDeletion } from '../memory/index';
import { chatMessage, conversation } from './persistence/tables';

/**
 * The deletion saga's source port for source_type 'chat' (spec §11.1;
 * ruling 7): the saga deletes the chat_message row through this, inside its
 * enumeration transaction, never through the table (spec §15 rule 2). The mirror of
 * ChatSourceReader — so a chat-derived memory's source deletion erases the
 * originating turn along with the derived memories and vectors, under one signed
 * receipt, exactly like a note.
 */
@Injectable()
export class ChatSourceDeletion implements SourceDeletion {
  readonly sourceType = 'chat' as const;

  async ownerOf(tx: Tx, sourceId: string): Promise<string | null> {
    const rows = await tx
      .select({ ownerId: chatMessage.ownerId })
      .from(chatMessage)
      .where(eq(chatMessage.id, sourceId))
      .for('update');
    return rows[0]?.ownerId ?? null;
  }

  /** A message's space is its CONVERSATION's space (docs/features/spaces.md):
   * the container carries the dimension. */
  async spaceOf(tx: Tx, sourceId: string): Promise<string | null> {
    const rows = await tx
      .select({ spaceId: conversation.spaceId })
      .from(chatMessage)
      .innerJoin(conversation, eq(conversation.id, chatMessage.conversationId))
      .where(eq(chatMessage.id, sourceId));
    return rows[0]?.spaceId ?? null;
  }

  async deleteSource(tx: Tx, sourceId: string): Promise<void> {
    await tx.delete(chatMessage).where(eq(chatMessage.id, sourceId));
  }

  /**
   * Deliberately EMPTY for owner erasure (issue #632), and implemented rather
   * than omitted so that this is a declaration and not an oversight.
   *
   * A message is a member of its conversation: `ConversationSourceDeletion`
   * enumerates it as a cascade sub-source, so every chat message an owner has
   * is already reached through its container. Listing messages here as well
   * would enumerate the same content twice — and worse, would let a single
   * message be erased out from under a conversation the shared-fact guard had
   * decided to retain.
   */
  async listForOwner(): Promise<OwnedSourceRef[]> {
    return [];
  }
}
