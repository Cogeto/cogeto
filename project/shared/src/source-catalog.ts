import type { ReadLocator } from './locator';
import type { MemoryListItem, SuppressedFactDto, VerificationDto } from './notes';
import type { SourceContextDto } from './extraction';

/**
 * The Sources surface (V2.2 item 5.2): the three-level read, audit and
 * resolve view. Level one is the catalog (one row per source with badges as
 * the scan layer); level two is the inspection (every fact with its located
 * span, the suppressed log, the contradictions in context); level three is
 * the fact detail, served by the existing memory endpoints plus the citing
 * answers.
 */

/** The badge conditions a row can carry and the list can filter by. */
export const SOURCE_BADGE_FILTERS = [
  'contradicted',
  'superseded',
  'suppressed',
  'truncated',
  'gated',
  'unreadable',
  'processing',
] as const;
export type SourceBadgeFilter = (typeof SOURCE_BADGE_FILTERS)[number];

/** A row's flags. Zero and false mean the row shows nothing: no green ticks. */
export interface SourceBadgesDto {
  /** Open contradictions this source's facts are party to. */
  contradictions: number;
  /** Facts superseded by later ones. */
  superseded: number;
  /** Suppressed-log entries: demoted or withheld facts. */
  suppressed: number;
  /** The read stopped at a cap; the read report carries the counts. */
  truncated: boolean;
  /** The extraction gate refused this source. */
  gated: boolean;
  /** The reading layer could not produce text (or the pipeline job died). */
  unreadable: boolean;
  /** The pipeline has not settled yet. */
  processing: boolean;
}

/**
 * Where a connector-synced source came from (V2.5 item 8.2): the audit trail
 * from fact to original, one click. Null on sources no connector produced.
 */
export interface SourceOriginDto {
  connectorKind: string;
  kind: 'page' | 'attachment';
  title: string | null;
  spaceKey: string | null;
  spaceName: string | null;
  version: number | null;
  /** The live upstream URL. */
  url: string | null;
  parentTitle: string | null;
  /** `absent` or `archived` when the upstream no longer lists the item; the
   * source remains, and the surface says so instead of deleting. */
  upstreamGone: string | null;
}

export interface SourceCatalogItemDto {
  sourceType: string;
  sourceId: string;
  /**
   * The display name: a note's opening line, an email's subject, a page's
   * title, a chat capture's excerpt, a file's filename (read from the object,
   * falling back to the anchored subject). Null when nothing names it: a
   * discarded original whose bytes and anchor are both gone.
   */
  name: string | null;
  at: string;
  factCount: number;
  badges: SourceBadgesDto;
  origin: SourceOriginDto | null;
  /** The project this source is grouped under (V2.5 item 8.3), or null.
   * Organisation, never authorisation: a source outside every project is as
   * visible as one inside a project. */
  projectId: string | null;
}

export interface SourceCatalogPageDto {
  items: SourceCatalogItemDto[];
  /**
   * Opaque date cursor for the next page; null when this page ends the list.
   * Badge-filtered lists are served whole (bounded) and carry no cursor.
   */
  nextCursor: string | null;
}

/** One fact of a source, with the verification evidence beside it. */
export interface SourceFactDto {
  memory: MemoryListItem;
  /** Null for user-authored rows (edit successors), which never verified. */
  verification: VerificationDto | null;
}

/** One lifecycle event of a finding (V2.3 item 6.1): the append-only history
 * the report's delta view and both inspection surfaces render. */
export interface RelationEventDto {
  event: string;
  /** Structural metadata only (ids, sides, pass names), never content. */
  detail: Record<string, unknown> | null;
  createdAt: string;
}

/** One contradiction touching a source, both parties resolved for display. */
export interface SourceContradictionDto {
  relationId: string;
  detectedAt: string;
  resolvedAt: string | null;
  resolution: string | null;
  /** Why the pair was flagged, the owner-gated explanation. */
  reason: string | null;
  /** Which pass found it (V2.3 item 6.1); null means "not recorded". */
  detectedBy: string | null;
  /** The finding's history, oldest first. */
  events: RelationEventDto[];
  a: MemoryListItem;
  b: MemoryListItem;
}

/** GET /api/source-catalog/:sourceType/:sourceId — level two, one round trip. */
export interface SourceInspectionDto {
  sourceType: string;
  sourceId: string;
  facts: SourceFactDto[];
  suppressed: SuppressedFactDto[];
  contradictions: SourceContradictionDto[];
  /** The anchoring context, when one exists (file sources). */
  context: SourceContextDto | null;
  /** The extraction gate's latest refusal reason, when it refused. */
  gateRefusal: string | null;
  /** Revision links touching this source, either side (V2.2 item 5.3). */
  revisions: import('./imports').SourceRevisionDto[];
  /** Connector provenance, when a connector produced this source. */
  origin: SourceOriginDto | null;
  /** The project this source is grouped under (V2.5 item 8.3), or null. */
  projectId: string | null;
}

/** One answer that cited a fact (V2.2 item 5.2, the fact detail view). */
export interface CitingAnswerDto {
  messageId: string;
  conversationId: string;
  conversationTitle: string | null;
  createdAt: string;
}

/** One contradiction relation of a fact, with the counterpart riding along. */
export interface MemoryRelationDto {
  relationId: string;
  detectedAt: string;
  resolvedAt: string | null;
  resolution: string | null;
  reason: string | null;
  /** Which pass found it (V2.3 item 6.1); null means "not recorded". */
  detectedBy: string | null;
  /** The finding's history, oldest first. */
  events: RelationEventDto[];
  other: MemoryListItem;
}

/** One change event for the filtered search's changed-since mode. */
export interface MemoryChangeDto {
  kind: 'learned' | 'status_changed' | 'superseded';
  at: string;
  memory: MemoryListItem;
  detail: { from: string | null; to: string | null; supersededBy: string | null };
}

/** A located span's render vocabulary re-exported beside its consumers. */
export type { ReadLocator };
