import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../infrastructure/index';
import type { Db, Tx } from '../infrastructure/index';
import { fileMetadata } from './persistence/tables';
import type { MemoryScope } from '@cogeto/shared';

/**
 * The memory module's public port over the `file_metadata` table (decision
 * 0003 ruling 2: memory owns ALL storage for memory data — file rows included;
 * the frozen upload contract, F1 handoff). The connectors file source writes
 * one row per stored upload through `record` (inside the same transaction as
 * the outbox enqueue) and reads it back through `get` — it never touches the
 * table directly (§A.1 rule 2). The deletion saga still deletes `file_metadata`
 * internally; this port adds no new deletion path.
 *
 * The row shape is frozen (F1 handoff, migration 0001): object_key, owner_id,
 * scope, sensitive, upload_date, checksum, size_bytes — no new columns. The
 * original filename and content type live on the MinIO object's metadata, so
 * they are erased with the bytes and need no schema of their own.
 */

export interface FileMetadataInsert {
  objectKey: string;
  ownerId: string;
  scope: MemoryScope;
  sensitive: boolean;
  checksum: string;
  sizeBytes: number;
}

export type FileMetadataRow = typeof fileMetadata.$inferSelect;

@Injectable()
export class MemoryFileStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Insert the metadata row inside the caller's transaction (upload path). */
  async record(tx: Tx, row: FileMetadataInsert): Promise<void> {
    await tx.insert(fileMetadata).values({
      objectKey: row.objectKey,
      ownerId: row.ownerId,
      scope: row.scope,
      sensitive: row.sensitive,
      checksum: row.checksum,
      sizeBytes: row.sizeBytes,
    });
  }

  /**
   * Admission checkpoint for stored-mode file sources (decision 0024): a
   * KEY SHARE existence check inside the pipeline's transaction, so it
   * serializes against the saga's FOR UPDATE + DELETE of the metadata row —
   * the file twin of NotesSourceReader.existsForAdmission. Discard-mode
   * sources have no row here by design; callers skip the checkpoint for them.
   */
  async existsForAdmission(tx: Tx, objectKey: string): Promise<boolean> {
    const rows = await tx
      .select({ objectKey: fileMetadata.objectKey })
      .from(fileMetadata)
      .where(eq(fileMetadata.objectKey, objectKey))
      .for('key share');
    return rows.length > 0;
  }

  /** The stored row, or null when absent (discarded original / never uploaded). */
  async get(objectKey: string): Promise<FileMetadataRow | null> {
    const rows = await this.db
      .select()
      .from(fileMetadata)
      .where(eq(fileMetadata.objectKey, objectKey))
      .limit(1);
    return rows[0] ?? null;
  }
}
