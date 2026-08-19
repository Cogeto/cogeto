import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { DEFAULT_SPACE_ID } from '@cogeto/shared';
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
 * The row shape (F1 handoff, migration 0001; space_id added by migration
 * 0060): object_key, owner_id, scope, sensitive, space_id, upload_date,
 * checksum, size_bytes. The original filename and content type live on the
 * MinIO object's metadata, so they are erased with the bytes and need no
 * schema of their own.
 */

export interface FileMetadataInsert {
  objectKey: string;
  ownerId: string;
  scope: MemoryScope;
  sensitive: boolean;
  /** The caller's current space (docs/features/spaces.md), stamped by the
   * upload path inside the transaction that creates the source. Omitted
   * (legacy harnesses) falls to the schema-level default space. */
  spaceId?: string;
  checksum: string;
  sizeBytes: number;
}

export type FileMetadataRow = typeof fileMetadata.$inferSelect;

@Injectable()
export class MemoryFileStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * The stored source already holding these exact bytes for this owner
   * (issue #536), or null. The port form of `findStoredDuplicate` below, for
   * the upload path — the files module reads no table itself (spec §15 rule 2).
   */
  async findDuplicate(
    ownerId: string,
    checksum: string,
    spaceId?: string,
  ): Promise<{ objectKey: string; scope: MemoryScope; sensitive: boolean } | null> {
    return findStoredDuplicate(this.db, ownerId, checksum, spaceId);
  }

  /** Insert the metadata row inside the caller's transaction (upload path). */
  async record(tx: Tx, row: FileMetadataInsert): Promise<void> {
    await tx.insert(fileMetadata).values({
      objectKey: row.objectKey,
      ownerId: row.ownerId,
      scope: row.scope,
      sensitive: row.sensitive,
      ...(row.spaceId ? { spaceId: row.spaceId } : {}),
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
  options: { cursor?: Date; order?: 'asc' | 'desc'; limit?: number; spaceId?: string } = {},
): Promise<FileSourceRefRow[]> {
  // The caller's current space (docs/features/spaces.md): a catalog listing
  // enumerates one space, never across the wall. Absent resolves to the
  // default space, which is where every pre-spaces row lives.
  const clauses = [
    eq(fileMetadata.ownerId, ownerId),
    eq(fileMetadata.spaceId, options.spaceId ?? DEFAULT_SPACE_ID),
  ];
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

/**
 * The space each of these object keys' stored metadata row carries
 * (docs/features/spaces.md): the catalog's belt for file refs that arrived
 * from an owner-keyed ledger with no space column of its own. One query over
 * the page's keys, never a query per row; a key absent from the map has no
 * metadata row (discard mode) and is resolved by the caller through the
 * gated describeSource read instead.
 */
export async function fileKeySpaces(
  db: DbOrTx,
  ownerId: string,
  keys: readonly string[],
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const rows = await db
    .select({ objectKey: fileMetadata.objectKey, spaceId: fileMetadata.spaceId })
    .from(fileMetadata)
    .where(and(eq(fileMetadata.ownerId, ownerId), inArray(fileMetadata.objectKey, [...keys])));
  return new Map(rows.map((row) => [row.objectKey, row.spaceId]));
}

/**
 * EVERY file source an owner has, with the scope its row records (issue #632).
 *
 * `file` is the one source type with no `SourceDeletion` adapter — its source
 * row IS `file_metadata`, which memory owns — so owner erasure enumerates it
 * here rather than through the port.
 *
 * Unpaginated, unlike `listFileSourceRefs` above, and the difference is the
 * point: that one serves a screen and is cursor-paged for it; this one serves
 * an erasure, where a bound would mean quietly leaving material behind.
 */
export async function listAllFileSourcesForOwner(
  db: DbOrTx,
  ownerId: string,
): Promise<{ sourceId: string; scope: MemoryScope }[]> {
  return db
    .select({ sourceId: fileMetadata.objectKey, scope: fileMetadata.scope })
    .from(fileMetadata)
    .where(eq(fileMetadata.ownerId, ownerId))
    .orderBy(asc(fileMetadata.uploadDate), asc(fileMetadata.objectKey));
}

/**
 * EVERY file source inside one space, with its owner — space deletion's
 * enumeration (docs/features/spaces.md section 5), the exact space twin of
 * the owner listing above and unpaginated for the same reason.
 */
export async function listAllFileSourcesForSpace(
  db: DbOrTx,
  spaceId: string,
): Promise<{ sourceId: string; ownerId: string }[]> {
  return db
    .select({ sourceId: fileMetadata.objectKey, ownerId: fileMetadata.ownerId })
    .from(fileMetadata)
    .where(eq(fileMetadata.spaceId, spaceId))
    .orderBy(asc(fileMetadata.uploadDate), asc(fileMetadata.objectKey));
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

export async function countFileSourceRefs(
  db: DbOrTx,
  ownerId: string,
  spaceId?: string,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(fileMetadata)
    .where(
      and(eq(fileMetadata.ownerId, ownerId), eq(fileMetadata.spaceId, spaceId ?? DEFAULT_SPACE_ID)),
    );
  return rows[0]?.n ?? 0;
}

/**
 * The stored upload this owner ALREADY has for these exact bytes, if any
 * (issue #536): the per-upload twin of the bulk manifest's batch check below.
 *
 * Owner-scoped, like every read here, and deliberately so: the same document
 * held by two users is two documents, because deduplicating across owners
 * would let one user's upload resolve to a source they cannot see. Dedup is a
 * cost and clutter decision; it never touches the gate.
 *
 * Scope and sensitivity come back with the key because the caller must
 * compare them: a duplicate is only a duplicate when it would have been
 * admitted the same way (see FilesService.upload).
 *
 * Oldest first, so a repeated upload always resolves to the SAME original
 * rather than drifting to whichever copy sorted first today.
 */
export async function findStoredDuplicate(
  db: DbOrTx,
  ownerId: string,
  checksum: string,
  spaceId?: string,
): Promise<{ objectKey: string; scope: MemoryScope; sensitive: boolean } | null> {
  const rows = await db
    .select({
      objectKey: fileMetadata.objectKey,
      scope: fileMetadata.scope,
      sensitive: fileMetadata.sensitive,
    })
    .from(fileMetadata)
    .where(
      and(
        eq(fileMetadata.ownerId, ownerId),
        // Dedup is PER SPACE by design (docs/features/spaces.md section 5):
        // the same file uploaded into two spaces is two independent sources,
        // because nothing may relate two spaces, not even a checksum.
        eq(fileMetadata.spaceId, spaceId ?? DEFAULT_SPACE_ID),
        eq(fileMetadata.checksum, checksum),
      ),
    )
    .orderBy(asc(fileMetadata.uploadDate), asc(fileMetadata.objectKey))
    .limit(1);
  return rows[0] ?? null;
}

/** Which of these content hashes already exist as stored uploads for this
 * owner (V2.2 item 5.3): the bulk manifest's duplicate detection. Per space,
 * like the per-upload twin above. */
export async function checksumsKnownForOwner(
  db: DbOrTx,
  ownerId: string,
  checksums: readonly string[],
  spaceId?: string,
): Promise<Set<string>> {
  if (checksums.length === 0) return new Set();
  const rows = await db
    .select({ checksum: fileMetadata.checksum })
    .from(fileMetadata)
    .where(
      and(
        eq(fileMetadata.ownerId, ownerId),
        eq(fileMetadata.spaceId, spaceId ?? DEFAULT_SPACE_ID),
        inArray(fileMetadata.checksum, [...checksums]),
      ),
    );
  return new Set(rows.map((row) => row.checksum).filter((c): c is string => c !== null));
}
