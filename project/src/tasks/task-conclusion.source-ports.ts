import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../infrastructure/index';
import type { Db, Tx } from '../infrastructure/index';
import type { SourceItem, SourceReader } from '../ingestion/index';
import type { SourceDeletion } from '../memory/index';
import { taskConclusion } from './persistence/tables';

/**
 * The source ports for source_type 'task_conclusion' (decision 0037; mirror of
 * the chat source ports, decision 0021): the pipeline reads a conclusion row
 * through the reader — never the table (§A.1 rule 2) — and the deletion saga
 * erases it through the deletion adapter, so a conclusion memory's source
 * deletion works exactly like a note's and the integrity sweep's orphan arm
 * (decision 0024) can probe the row.
 *
 * The reader carries the conclusion's scope and sensitive flag into the
 * SourceItem so the derived memory inherits both (decision 0037 ruling 3).
 */
@Injectable()
export class TaskConclusionSourceReader implements SourceReader {
  readonly sourceType = 'task_conclusion' as const;

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async load(sourceId: string): Promise<SourceItem | null> {
    const rows = await this.db
      .select()
      .from(taskConclusion)
      .where(eq(taskConclusion.id, sourceId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      sourceType: this.sourceType,
      sourceId: row.id,
      ownerId: row.ownerId,
      content: row.statement,
      createdAt: row.createdAt,
      scope: row.scope,
      sensitive: row.sensitive,
    };
  }

  /** Admission checkpoint (decision 0024): KEY SHARE serializes against the
   * deletion saga's FOR UPDATE + DELETE on this conclusion row. */
  async existsForAdmission(tx: Tx, sourceId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: taskConclusion.id })
      .from(taskConclusion)
      .where(eq(taskConclusion.id, sourceId))
      .for('key share');
    return rows.length > 0;
  }
}

/**
 * The deletion saga's source port for 'task_conclusion' (§A.7): deleting a
 * conclusion memory's source erases the conclusion row along with the derived
 * memory and its vectors, under one signed receipt — exactly like a note.
 */
@Injectable()
export class TaskConclusionSourceDeletion implements SourceDeletion {
  readonly sourceType = 'task_conclusion' as const;

  async ownerOf(tx: Tx, sourceId: string): Promise<string | null> {
    const rows = await tx
      .select({ ownerId: taskConclusion.ownerId })
      .from(taskConclusion)
      .where(eq(taskConclusion.id, sourceId))
      .for('update');
    return rows[0]?.ownerId ?? null;
  }

  async deleteSource(tx: Tx, sourceId: string): Promise<void> {
    await tx.delete(taskConclusion).where(eq(taskConclusion.id, sourceId));
  }
}

/**
 * Global slim module so both composition roots resolve the ports without
 * pulling the full TasksModule graph — the mirror of ChatSourceModule.
 */
@Global()
@Module({
  providers: [TaskConclusionSourceReader, TaskConclusionSourceDeletion],
  exports: [TaskConclusionSourceReader, TaskConclusionSourceDeletion],
})
export class TaskConclusionSourceModule {}
