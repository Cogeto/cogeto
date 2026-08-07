import type { ReadLocator } from './locator';
import type { FactKind, MemoryScope, MemoryStatus, UncertaintyReason } from './memory';

/** Notes capture DTOs: POST /api/notes and the processing-status poll. */

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

/** One row of the governed Memories list (dashboard). */
export interface MemoryListItem {
  id: string;
  content: string | null;
  status: MemoryStatus;
  /**
   * Why the fact was admitted `uncertain` (V2.0 item 3.3); null when it never
   * was. Retained after the status moves on, since it records the admission
   * rather than mirroring the current state. Display only: the sub-reason may
   * inform framing, never a gate.
   */
  uncertaintyReason: UncertaintyReason | null;
  scope: MemoryScope;
  /** The owning user's Zitadel id — the UI gates owner-only actions on
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
  /** Raw temporal phrases code could not resolve. */
  temporalUnresolved: string[];
  createdAt: string;
}

/** GET /api/memories envelope: `total` counts everything under the filters. */
export interface MemoryPage {
  items: MemoryListItem[];
  total: number;
}

/** GET /api/memories/:id/verification — the spec §2 verdict that earned the status. */
export interface VerificationDto {
  verdict: 'supported' | 'partial' | 'unsupported';
  reason: string;
  promptVersion: string;
  /** The extractor's cited source passage; null for pre- rows. */
  sourceSpan: string | null;
  /** The tentative wording behind `hedged_in_source`; null otherwise. */
  hedgePhrase: string | null;
  /**
   * The span resolved to the reader seam's structured locators at admission
   * (V2.2 item 5.2). Null means no location: a segment-less source (note,
   * chat, email, web), a span locateSpan could not find, or a fact admitted
   * before locators were persisted.
   */
  spanLocators: ReadLocator[] | null;
  createdAt: string;
}

/**
 * One entry in the suppressed-fact log (V2.0 item 3.3): an automatic decision
 * that demoted or withheld an extracted fact. `memoryId` is set when the fact
 * WAS admitted as uncertain and null when it was not admitted at all.
 */
export interface SuppressedFactDto {
  id: string;
  sourceType: string;
  sourceId: string;
  /** The claim exactly as the extractor produced it. */
  factContent: string;
  factKind: FactKind | null;
  /** The exact source substring the claim was drawn from. */
  sourceSpan: string;
  /** The span's structured locators (V2.2 item 5.2); null when unlocatable. */
  spanLocators: ReadLocator[] | null;
  reason: UncertaintyReason;
  /** The verification detail behind the decision; null when none ran. */
  verificationVerdict: 'supported' | 'partial' | 'unsupported' | null;
  verificationReason: string | null;
  promptVersion: string | null;
  memoryId: string | null;
  createdAt: string;
}

/** GET /api/suppressed-facts — the paged, gated log. */
export interface SuppressedFactPageDto {
  items: SuppressedFactDto[];
  total: number;
}

/** GET /api/suppressed-facts/summary — counts per reason, zeros included. */
export interface SuppressedFactSummaryDto {
  total: number;
  byReason: Record<UncertaintyReason, number>;
}

/**
 * One open contradiction in the Review queue (GET /api/relations). `a` is the fact reconciliation admitted more recently, `b` the one
 * that was already on record.
 */
export interface ContradictionDto {
  id: string;
  detectedAt: string;
  /** Why reconciliation flagged the pair — owner-gated (from the relation row,
   * migration 0020); null on pre-0020 detections. */
  reason: string | null;
  /** Which pass found it (V2.3 item 6.1); null means "not recorded". */
  detectedBy: string | null;
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
 * GET /api/dreaming/latest — the plain digest ( v1 form)
 * the most recent finished dreaming run's actions as at most six
 * human-phrased, deep-linked lines, scoped to the caller's own memories.
 * `lines: []` means render nothing — silent nights produce no panel.
 */
export interface DreamDigestLine {
  text: string;
  /** SPA route the line deep-links to; always resolvable for the caller. */
  href: string;
  /**
   * Which panel section the line belongs to. Since V2.0 the
   * digest has exactly one section — the nightly consolidation; the tasks
   * section went with the task subsystem. Optional, absent reads as
   * `consolidation`.
   */
  section?: 'consolidation';
}

export interface DreamDigestDto {
  runId: string | null;
  finishedAt: string | null;
  lines: DreamDigestLine[];
}

/** GET /api/jobs/dead-letter — parked jobs, dashboard-visible (spec §15.4). */
export interface DeadLetterJobDto {
  id: string;
  jobType: string;
  sourceType: string | null;
  sourceId: string | null;
  error: string;
  attempts: number;
  failedAt: string;
}
