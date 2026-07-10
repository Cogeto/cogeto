import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../infrastructure/index';
import type { Db, Tx } from '../infrastructure/index';
import type { SourceItem, SourceReader } from '../ingestion/index';
import { note } from './persistence/tables';

/**
 * Ingestion's stage-1 port for source_type 'user_note' (the pipeline reads
 * sources through this, never through the note table). Bound to the
 * SOURCE_READERS token by the worker composition root.
 */
@Injectable()
export class NotesSourceReader implements SourceReader {
  readonly sourceType = 'user_note' as const;

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async load(sourceId: string): Promise<SourceItem | null> {
    const rows = await this.db.select().from(note).where(eq(note.id, sourceId)).limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      sourceType: this.sourceType,
      sourceId: row.id,
      ownerId: row.ownerId,
      content: row.content,
      // The capture-time scope (O2-B); memories inherit it in embed-store.
      scope: row.scope,
      createdAt: row.createdAt,
    };
  }

  /**
   * Admission checkpoint (decision 0024): KEY SHARE serializes against the
   * deletion saga's FOR UPDATE + DELETE on this note row — see SourceReader.
   */
  async existsForAdmission(tx: Tx, sourceId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: note.id })
      .from(note)
      .where(eq(note.id, sourceId))
      .for('key share');
    return rows.length > 0;
  }
}
