import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { resolveSpaceId } from '@cogeto/shared';
import type { MemoryScope, NoteProcessingState, Principal } from '@cogeto/shared';
import {
  DailyCounters,
  DRIZZLE,
  INGEST_QUOTA,
  jobRunState,
  userError,
  withTransactionalEnqueue,
} from '../infrastructure/index';
import type { Db, IngestQuota } from '../infrastructure/index';
import { INGESTION_PIPELINE_JOB_TYPE } from '../ingestion/index';
import { note } from './persistence/tables';
import type { NoteRow } from './persistence/tables';

/**
 * The notes source ( — Notes first). Capture is transactional via the
 * outbox (spec §15.4): the note row, its domain event and its pipeline job commit
 * together — a captured note can never be silently unprocessed.
 */
@Injectable()
export class NotesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly counters: DailyCounters,
    @Inject(INGEST_QUOTA) private readonly quota: IngestQuota,
  ) {}

  async createNote(
    principal: Principal,
    content: string,
    scope: MemoryScope = 'private',
  ): Promise<NoteRow> {
    // Per-user daily capture cap: bounds the pipeline model work a
    // single user (or the shared demo principal) can drive in a day. Reserved
    // BEFORE the write so a burst cannot slip past the check.
    if ((await this.counters.get(principal.userId, 'capture')) >= this.quota.captureMax) {
      throw userError.tooManyRequests(
        'daily_capture_limit',
        'daily capture limit reached ({{max}}), try again tomorrow',
        { max: this.quota.captureMax },
      );
    }
    const created = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(note)
        // The caller's current space is stamped in the same transaction that
        // creates the source (docs/features/spaces.md): an un-spaced source
        // cannot be created.
        .values({ ownerId: principal.userId, content, scope, spaceId: resolveSpaceId(principal) })
        .returning();
      const inserted = row as NoteRow;
      await withTransactionalEnqueue(
        tx,
        {
          type: 'note.captured',
          payload: { source_type: 'user_note', source_id: inserted.id, owner_id: inserted.ownerId },
        },
        {
          type: INGESTION_PIPELINE_JOB_TYPE,
          payload: { source_type: 'user_note', source_id: inserted.id },
        },
      );
      return inserted;
    });
    await this.counters.add(principal.userId, 'capture', 1);
    return created;
  }

  /** Owner-only read — the source drawer behind every memory's source link.
   * Space-scoped like every read (docs/features/spaces.md): a note in
   * another space is not found, even for its owner. */
  async getNoteForOwner(principal: Principal, noteId: string): Promise<NoteRow | null> {
    const rows = await this.db
      .select()
      .from(note)
      .where(
        and(
          eq(note.id, noteId),
          eq(note.ownerId, principal.userId),
          eq(note.spaceId, resolveSpaceId(principal)),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Processing state from the queue's own ledgers (no extra bookkeeping)
   * the job_execution idempotency row means the pipeline job committed; a
   * dead_letter row means it exhausted its retries; otherwise it is queued
   * or running.
   */
  async getProcessingState(noteId: string): Promise<NoteProcessingState> {
    return jobRunState(this.db, {
      sourceType: 'user_note',
      sourceId: noteId,
      jobType: INGESTION_PIPELINE_JOB_TYPE,
    });
  }
}
