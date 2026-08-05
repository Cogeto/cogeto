import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../infrastructure/index';
import type { DerivedCascade } from '../memory/index';
import { chatAttachment } from './persistence/tables';

/**
 * Deletion coverage for conversation attachments (V2.2 item 5.1). Two legs,
 * one adapter, both source-keyed:
 *
 * - **`chat_conversation`**: the conversation's attachment rows are REMOVED
 *   inside the enumeration transaction and counted on the receipt
 *   (`chat_attachments_removed`) — a transient row holds the file's extracted
 *   text and its name, so the erasure claim would be incomplete without it.
 *   The FK's ON DELETE CASCADE remains the safety net.
 *
 * - **`file`**: a durable attachment row is a LINK to the erased source, and
 *   the filename on it is exactly the orphan the object-key contract exists
 *   to prevent ("no orphaned filename survives a provable deletion"). The leg
 *   nulls the name, drops the link and marks the row `source_deleted`, so the
 *   conversation shows an honest "attachment removed" rather than a card
 *   naming a file the receipt says is gone. Returns 0: nothing content-
 *   bearing is REMOVED here, and the receipt count must stay real removals.
 */
@Injectable()
export class ChatAttachmentCascade implements DerivedCascade {
  readonly artifact = 'chat_attachments';

  async cascadeForMemories(): Promise<number> {
    return 0;
  }

  async cascadeForSource(tx: Tx, sourceType: string, sourceId: string): Promise<number> {
    if (sourceType === 'chat_conversation') {
      const removed = await tx
        .delete(chatAttachment)
        .where(eq(chatAttachment.conversationId, sourceId))
        .returning({ id: chatAttachment.id });
      return removed.length;
    }
    if (sourceType === 'file') {
      await tx
        .update(chatAttachment)
        .set({ displayName: null, objectKey: null, status: 'source_deleted' })
        .where(and(eq(chatAttachment.objectKey, sourceId), eq(chatAttachment.transient, false)));
      return 0;
    }
    return 0;
  }
}
