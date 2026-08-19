import { Injectable } from '@nestjs/common';
import { asc, eq, inArray, or } from 'drizzle-orm';
import type { DbOrTx, Tx } from '../infrastructure/index';
import type { OwnedSourceRef, SourceCascade, SourceDeletion } from '../memory/index';
import { emailAttachment, emailMessage } from './persistence/tables';

/**
 * The deletion saga's source port for source_type 'email'. Deleting an email source must remove the WHOLE retained
 * message, not just its body memories
 *
 * - `deleteSource` removes the `email_message` row inside the enumeration
 *   transaction (email_attachment rows go with it via ON DELETE CASCADE).
 * - `enumerateCascade` hands the saga the connector-owned objects it stored (the
 *   raw original + the sanitised-HTML object, when externalised) and the
 *   attachment `file` sub-sources (each with its own file_metadata, object, and
 *   derived memories). The saga folds all of these into the SAME receipt, so the
 *   erasure is honest and complete — zero residue across every store.
 *
 * Never touches memory/file_metadata tables (spec §15 rule 2) — that is the saga's
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

  /** The space the message row carries (docs/features/spaces.md): stamps the
   * deletion receipt onto its space's chain. */
  async spaceOf(tx: Tx, sourceId: string): Promise<string | null> {
    const rows = await tx
      .select({ spaceId: emailMessage.spaceId })
      .from(emailMessage)
      .where(eq(emailMessage.id, sourceId));
    return rows[0]?.spaceId ?? null;
  }

  async deleteSource(tx: Tx, sourceId: string): Promise<void> {
    // email_attachment rows cascade via their FK (ON DELETE CASCADE).
    await tx.delete(emailMessage).where(eq(emailMessage.id, sourceId));
  }

  /** Owner erasure's enumeration (issue #632). The message row carries the
   * scope it was captured under; its attachments are cascade members of this
   * source and are never listed separately, so an attachment can neither be
   * missed nor enumerated twice. */
  async listForOwner(db: DbOrTx, ownerId: string): Promise<OwnedSourceRef[]> {
    return db
      .select({ sourceId: emailMessage.id, scope: emailMessage.scope })
      .from(emailMessage)
      .where(eq(emailMessage.ownerId, ownerId))
      .orderBy(asc(emailMessage.id));
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

  /**
   * The integrity sweep's legitimacy probe: retained emails store
   * their raw original (and sometimes an externalised HTML body) as objects
   * recorded on email_message — NOT in file_metadata — so the orphan arm asks
   * here before flagging. Only keys belonging to a LIVE email row are owned;
   * an abandoned email object (crashed intake) matches nothing and is still
   * flagged, keeping the sweep's backstop role intact.
   */
  async ownsObjectKeys(db: DbOrTx, keys: readonly string[]): Promise<string[]> {
    if (keys.length === 0) return [];
    const batch = [...keys];
    const rows = await db
      .select({
        rawObjectKey: emailMessage.rawObjectKey,
        htmlObjectKey: emailMessage.htmlObjectKey,
      })
      .from(emailMessage)
      .where(
        or(inArray(emailMessage.rawObjectKey, batch), inArray(emailMessage.htmlObjectKey, batch)),
      );
    const wanted = new Set(batch);
    const owned: string[] = [];
    for (const row of rows) {
      if (row.rawObjectKey && wanted.has(row.rawObjectKey)) owned.push(row.rawObjectKey);
      if (row.htmlObjectKey && wanted.has(row.htmlObjectKey)) owned.push(row.htmlObjectKey);
    }
    return owned;
  }
}
