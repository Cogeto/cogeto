import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { DRIZZLE } from '../infrastructure/index';
import type { Db, DbOrTx, Tx } from '../infrastructure/index';
import { fileMetadata } from './persistence/tables';
import type { MemoryScope } from '@cogeto/shared';

/**
 * The memory module's public port over the `file_metadata` table
 * : memory owns ALL storage for memory data — file rows included;
 * the frozen upload contract, F1 handoff). The connectors file source writes
 * one row per stored upload through `record` (inside the same transaction as
 * the outbox enqueue) and reads it back through `get` — it never touches the
 * table directly (spec §15 rule 2). The deletion saga still deletes `file_metadata`
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
   * Admission checkpoint for stored-mode file sources: a
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

/**
 * The file rows' contribution to the source catalog (V2.2 item 5.2): plain
 * owner-scoped listings over `file_metadata`, memory's own table. The display
 * name is deliberately ABSENT here: a filename lives on the object's metadata
 * (erased with the bytes), so the catalog resolves names per page via the
 * object store and the anchoring context, never from a column.
 */
export interface FileSourceRefRow {
  objectKey: string;
  at: Date;
}

export async function listFileSourceRefs(
  db: DbOrTx,
  ownerId: string,
  options: { cursor?: Date; order?: 'asc' | 'desc'; limit?: number } = {},
): Promise<FileSourceRefRow[]> {
  const clauses = [eq(fileMetadata.ownerId, ownerId)];
  const order = options.order ?? 'desc';
  if (options.cursor) {
    clauses.push(
      order === 'desc'
        ? lt(fileMetadata.uploadDate, options.cursor)
        : gt(fileMetadata.uploadDate, options.cursor),
    );
  }
  const rows = await db
    .select({ objectKey: fileMetadata.objectKey, uploadDate: fileMetadata.uploadDate })
    .from(fileMetadata)
    .where(and(...clauses))
    .orderBy(
      order === 'desc' ? desc(fileMetadata.uploadDate) : asc(fileMetadata.uploadDate),
      order === 'desc' ? desc(fileMetadata.objectKey) : asc(fileMetadata.objectKey),
    )
    .limit(Math.min(options.limit ?? 50, 200));
  return rows.map((row) => ({ objectKey: row.objectKey, at: row.uploadDate }));
}

export async function hydrateFileSourceRefs(
  db: DbOrTx,
  ownerId: string,
  keys: readonly string[],
): Promise<Map<string, FileSourceRefRow>> {
  if (keys.length === 0) return new Map();
  const rows = await db
    .select({ objectKey: fileMetadata.objectKey, uploadDate: fileMetadata.uploadDate })
    .from(fileMetadata)
    .where(and(eq(fileMetadata.ownerId, ownerId), inArray(fileMetadata.objectKey, [...keys])));
  return new Map(
    rows.map((row) => [row.objectKey, { objectKey: row.objectKey, at: row.uploadDate }]),
  );
}

export async function countFileSourceRefs(db: DbOrTx, ownerId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(fileMetadata)
    .where(eq(fileMetadata.ownerId, ownerId));
  return rows[0]?.n ?? 0;
}
