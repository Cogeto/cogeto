import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { DbOrTx, Tx } from '../infrastructure/index';
import type { OwnedSourceRef, SpaceSourceRef, SourceDeletion } from '../memory/index';
import { note } from './persistence/tables';

/**
 * The deletion saga's source port for source_type 'user_note' (spec §11.1): the
 * saga deletes the note row through this, inside its enumeration transaction,
 * never through the note table (spec §15 rule 2). Bound to SOURCE_DELETIONS by
 * the composition roots — the mirror of NotesSourceReader.
 */
@Injectable()
export class NotesSourceDeletion implements SourceDeletion {
  readonly sourceType = 'user_note' as const;

  async ownerOf(tx: Tx, sourceId: string): Promise<string | null> {
    // Locked FOR UPDATE: a concurrent capture/pipeline run on this note must
    // serialize against the enumeration transaction.
    const rows = await tx
      .select({ ownerId: note.ownerId })
      .from(note)
      .where(eq(note.id, sourceId))
      .for('update');
    return rows[0]?.ownerId ?? null;
  }

  /** The space the note row carries (docs/features/spaces.md): stamps the
   * deletion receipt onto its space's chain. */
  async spaceOf(tx: Tx, sourceId: string): Promise<string | null> {
    const rows = await tx.select({ spaceId: note.spaceId }).from(note).where(eq(note.id, sourceId));
    return rows[0]?.spaceId ?? null;
  }

  async deleteSource(tx: Tx, sourceId: string): Promise<void> {
    await tx.delete(note).where(eq(note.id, sourceId));
  }

  /** Owner erasure's enumeration (issue #632). A note carries its capture-time
   * scope on the row (migration 0018), which is the scope reported here. */
  async listForOwner(db: DbOrTx, ownerId: string): Promise<OwnedSourceRef[]> {
    return db
      .select({ sourceId: note.id, scope: note.scope })
      .from(note)
      .where(eq(note.ownerId, ownerId))
      .orderBy(asc(note.createdAt), asc(note.id));
  }

  /** Space deletion's enumeration (docs/features/spaces.md section 5). */
  async listForSpace(db: DbOrTx, spaceId: string): Promise<SpaceSourceRef[]> {
    return db
      .select({ sourceId: note.id, ownerId: note.ownerId })
      .from(note)
      .where(eq(note.spaceId, spaceId))
      .orderBy(asc(note.createdAt), asc(note.id));
  }
}
