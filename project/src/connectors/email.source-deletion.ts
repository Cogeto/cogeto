import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Tx } from '../infrastructure/index';
import type { SourceCascade, SourceDeletion } from '../memory/index';
import { emailAttachment, emailMessage } from './persistence/tables';

/**
 * The deletion saga's source port for source_type 'email' (Session O4 — email
 * source; §A.7). Deleting an email source must remove the WHOLE retained
 * message, not just its body memories:
 *
 * - `deleteSource` removes the `email_message` row inside the enumeration
 *   transaction (email_attachment rows go with it via ON DELETE CASCADE).
 * - `enumerateCascade` hands the saga the connector-owned objects it stored (the
 *   raw original + the sanitised-HTML object, when externalised) and the
 *   attachment `file` sub-sources (each with its own file_metadata, object, and
 *   derived memories). The saga folds all of these into the SAME receipt, so the
 *   erasure is honest and complete — zero residue across every store.
 *
 * Never touches memory/file_metadata tables (§A.1 rule 2) — that is the saga's
 * job; this adapter only reads its own connector tables and deletes its own row.
 */
@Injectable()
export class EmailSourceDeletion implements SourceDeletion {
  readonly sourceType = 'email' as const;

  async ownerOf(tx: Tx, sourceId: string): Promise<string | null> {
    const rows = await tx
      .select({ ownerId: emailMessage.ownerId })
      .from(emailMessage)
      .where(eq(emailMessage.id, sourceId))
      .for('update');
    return rows[0]?.ownerId ?? null;
  }

  async deleteSource(tx: Tx, sourceId: string): Promise<void> {
    // email_attachment rows cascade via their FK (ON DELETE CASCADE).
    await tx.delete(emailMessage).where(eq(emailMessage.id, sourceId));
  }

  async enumerateCascade(tx: Tx, sourceId: string): Promise<SourceCascade> {
    const messageRows = await tx
      .select({
        rawObjectKey: emailMessage.rawObjectKey,
        htmlObjectKey: emailMessage.htmlObjectKey,
      })
      .from(emailMessage)
      .where(eq(emailMessage.id, sourceId));
    const message = messageRows[0];

    const objectKeys: string[] = [];
    if (message?.rawObjectKey) objectKeys.push(message.rawObjectKey);
    if (message?.htmlObjectKey) objectKeys.push(message.htmlObjectKey);

    // Supported attachments were stored as their own 'file' sources; their object
    // key is the file source id the saga cascades (memories + file_metadata +
    // object). Unsupported attachments carry no file object — nothing to cascade
    // (their bytes live only in the raw original, removed above).
    const attachmentRows = await tx
      .select({ fileObjectKey: emailAttachment.fileObjectKey })
      .from(emailAttachment)
      .where(eq(emailAttachment.emailId, sourceId));
    const fileSubSourceKeys = attachmentRows
      .map((r) => r.fileObjectKey)
      .filter((key): key is string => key !== null);

    return { objectKeys, fileSubSourceKeys };
  }
}
