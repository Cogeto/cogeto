import type { MemoryScope, MemoryStatus } from './memory';

/** Notes capture DTOs (S2-A): POST /api/notes and the processing-status poll. */

export interface NoteCaptureRequest {
  content: string;
}

export interface NoteCaptured {
  id: string;
  createdAt: string;
}

export interface NoteDto {
  id: string;
  content: string;
  createdAt: string;
}

/**
 * Derived from the queue's own ledgers: `done` = the pipeline job's idempotency
 * row exists; `failed` = the job is in the dead-letter table; otherwise the job
 * is queued or running.
 */
export type NoteProcessingState = 'processing' | 'done' | 'failed';

export interface NoteStatusDto {
  state: NoteProcessingState;
}

/** One row of the Memories (preview) list — replaced by the S3 dashboard. */
export interface MemoryListItem {
  id: string;
  content: string | null;
  status: MemoryStatus;
  scope: MemoryScope;
  sensitive: boolean;
  sourceType: string;
  sourceId: string;
  validFrom: string | null;
  validUntil: string | null;
  createdAt: string;
}
