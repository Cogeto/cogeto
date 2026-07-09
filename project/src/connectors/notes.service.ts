import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { MemoryScope, NoteProcessingState, Principal } from '@cogeto/shared';
import {
  deadLetter,
  DRIZZLE,
  jobExecution,
  withTransactionalEnqueue,
} from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { INGESTION_PIPELINE_JOB_TYPE } from '../ingestion/index';
import { note } from './persistence/tables';
import type { NoteRow } from './persistence/tables';

/**
 * The notes source (§A.11 — Notes first). Capture is transactional via the
 * outbox (§A.3): the note row, its domain event and its pipeline job commit
 * together — a captured note can never be silently unprocessed.
 */
@Injectable()
export class NotesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async createNote(
    principal: Principal,
    content: string,
    scope: MemoryScope = 'private',
  ): Promise<NoteRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(note)
        .values({ ownerId: principal.userId, content, scope })
        .returning();
      const created = row as NoteRow;
      await withTransactionalEnqueue(
        tx,
        {
          type: 'note.captured',
          payload: { source_type: 'user_note', source_id: created.id, owner_id: created.ownerId },
        },
        {
          type: INGESTION_PIPELINE_JOB_TYPE,
          payload: { source_type: 'user_note', source_id: created.id },
        },
      );
      return created;
    });
  }

  /** Owner-only read — the source drawer behind every memory's source link. */
  async getNoteForOwner(principal: Principal, noteId: string): Promise<NoteRow | null> {
    const rows = await this.db
      .select()
      .from(note)
      .where(and(eq(note.id, noteId), eq(note.ownerId, principal.userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Processing state from the queue's own ledgers (no extra bookkeeping):
   * the job_execution idempotency row means the pipeline job committed; a
   * dead_letter row means it exhausted its retries; otherwise it is queued
   * or running.
   */
  async getProcessingState(noteId: string): Promise<NoteProcessingState> {
    const done = await this.db
      .select({ id: jobExecution.id })
      .from(jobExecution)
      .where(
        and(
          eq(jobExecution.sourceType, 'user_note'),
          eq(jobExecution.sourceId, noteId),
          eq(jobExecution.jobType, INGESTION_PIPELINE_JOB_TYPE),
        ),
      )
      .limit(1);
    if (done.length > 0) return 'done';

    const failed = await this.db
      .select({ id: deadLetter.id })
      .from(deadLetter)
      .where(
        and(
          eq(deadLetter.jobType, INGESTION_PIPELINE_JOB_TYPE),
          sql`${deadLetter.payload}->>'source_id' = ${noteId}`,
        ),
      )
      .limit(1);
    return failed.length > 0 ? 'failed' : 'processing';
  }
}
