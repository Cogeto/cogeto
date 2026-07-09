import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Tx } from '../../infrastructure/index';
import type { SourceDeletion } from '../../memory/index';
import { chatMessage } from '../persistence/tables';

/**
 * The deletion saga's source port for source_type 'chat' (§A.7; decision 0021
 * ruling 7): the saga deletes the chat_message row through this, inside its
 * enumeration transaction, never through the table (§A.1 rule 2). The mirror of
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

  async deleteSource(tx: Tx, sourceId: string): Promise<void> {
    await tx.delete(chatMessage).where(eq(chatMessage.id, sourceId));
  }
}
