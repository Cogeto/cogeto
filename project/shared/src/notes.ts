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

/** One row of the governed Memories list (S3-B dashboard). */
export interface MemoryListItem {
  id: string;
  content: string | null;
  status: MemoryStatus;
  scope: MemoryScope;
  sensitive: boolean;
  entities: string[];
  sourceType: string;
  sourceId: string;
  supersededBy: string | null;
  validFrom: string | null;
  validUntil: string | null;
  /** Raw temporal phrases code could not resolve (decision 0007 ruling 1). */
  temporalUnresolved: string[];
  createdAt: string;
}

/** GET /api/memories envelope: `total` counts everything under the filters. */
export interface MemoryPage {
  items: MemoryListItem[];
  total: number;
}

/** GET /api/memories/:id/verification — the §B.3 verdict that earned the status. */
export interface VerificationDto {
  verdict: 'supported' | 'partial' | 'unsupported';
  reason: string;
  promptVersion: string;
  /** The extractor's cited source passage; null for pre-S3-B rows. */
  sourceSpan: string | null;
  createdAt: string;
}

/** GET /api/jobs/dead-letter — parked jobs, dashboard-visible (§A.3). */
export interface DeadLetterJobDto {
  id: string;
  jobType: string;
  sourceType: string | null;
  sourceId: string | null;
  error: string;
  attempts: number;
  failedAt: string;
}
