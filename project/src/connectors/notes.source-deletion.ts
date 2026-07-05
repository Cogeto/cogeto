import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Tx } from '../infrastructure/index';
import type { SourceDeletion } from '../memory/index';
import { note } from './persistence/tables';

/**
 * The deletion saga's source port for source_type 'user_note' (§A.7): the
 * saga deletes the note row through this, inside its enumeration transaction,
 * never through the note table (§A.1 rule 2). Bound to SOURCE_DELETIONS by
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

  async deleteSource(tx: Tx, sourceId: string): Promise<void> {
    await tx.delete(note).where(eq(note.id, sourceId));
  }
}
