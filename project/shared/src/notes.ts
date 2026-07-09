import type { FactKind, MemoryScope, MemoryStatus } from './memory';

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
  /** The owning user's Zitadel id (O2-B) — the UI gates owner-only actions on
   * `ownerId === me.userId`; the server enforces it regardless. */
  ownerId: string;
  /** The owner's display name, resolved from the identity directory; null when
   * unknown (e.g. the owner has not logged in since provisioning). */
  ownerName: string | null;
  sensitive: boolean;
  entities: string[];
  /** The extractor's fact kind (migration 0011); null on pre-F2 rows. */
  kind: FactKind | null;
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

/**
 * One open contradiction in the Review queue (GET /api/relations; decision
 * 0010). `a` is the fact reconciliation admitted more recently, `b` the one
 * that was already on record.
 */
export interface ContradictionDto {
  id: string;
  detectedAt: string;
  a: MemoryListItem;
  b: MemoryListItem;
}

/** POST /api/relations/:id/resolve — the three owner actions (0010 ruling 3). */
export type ResolveContradictionRequest =
  | { action: 'confirm_a' }
  | { action: 'confirm_b' }
  | { action: 'correct'; aContent: string; bContent: string }
  | { action: 'dismiss' };

/**
 * GET /api/dreaming/latest — the plain digest (§B.6 v1 form; decision 0011):
 * the most recent finished dreaming run's actions as at most six
 * human-phrased, deep-linked lines, scoped to the caller's own memories.
 * `lines: []` means render nothing — silent nights produce no panel.
 */
export interface DreamDigestLine {
  text: string;
  /** SPA route the line deep-links to; always resolvable for the caller. */
  href: string;
  /**
   * Which panel section the line belongs to (O2-A): the nightly consolidation
   * or the tasks reminders/updates. Optional for back-compat; absent reads as
   * `consolidation`. The digest is one surface with two sections (F3 §3).
   */
  section?: 'consolidation' | 'tasks';
}

export interface DreamDigestDto {
  runId: string | null;
  finishedAt: string | null;
  lines: DreamDigestLine[];
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
