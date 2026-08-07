/** Bulk import (V2.2 item 5.3): manifest-first, queued, honest to the end. */

export type ImportKind = 'zip' | 'folder' | 's3';
export type ImportRunState = 'manifest' | 'running' | 'completed' | 'cancelled' | 'failed';
export type ImportItemState =
  | 'listed'
  | 'excluded'
  | 'unsupported'
  | 'duplicate'
  | 'queued'
  | 'ingested'
  | 'failed'
  | 'cancelled'
  | 'tombstoned';

export interface ImportItemDto {
  id: string;
  /** Null once the ingested source was erased (the tombstone). */
  name: string | null;
  sizeBytes: number | null;
  contentType: string | null;
  state: ImportItemState;
  reason: string | null;
  /** The existing source this item's filename nominates as a predecessor. */
  revisionOf: string | null;
  objectKey: string | null;
}

/** The completion summary. Every number is real; nothing is rounded up. */
export interface ImportCountsDto {
  documents: number;
  facts: number;
  contradictions: number;
  superseded: number;
  duplicatesSkipped: number;
  revisionsLinked: number;
  revisionsProposed: number;
  unreadable: number;
  gated: number;
  truncated: number;
  failed: number;
  excluded: number;
  unsupported: number;
  cancelled: number;
}

export interface ImportProgressDto {
  total: number;
  done: number;
  failed: number;
  inFlight: number;
  remaining: number;
  duplicates: number;
  unsupported: number;
  excluded: number;
  cancelled: number;
}

export interface ImportRunDto {
  id: string;
  kind: ImportKind;
  state: ImportRunState;
  sourceLabel: string | null;
  /** Why the coordinator is waiting, when it is (the daily upload cap). */
  pausedReason: string | null;
  counts: ImportCountsDto | null;
  progress: ImportProgressDto;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ImportRunDetailDto extends ImportRunDto {
  items: ImportItemDto[];
}

/** POST /api/imports/folder — the browser-enumerated manifest request. */
export interface FolderManifestRequest {
  sourceLabel?: string;
  items: { name: string; sizeBytes: number; contentHash: string }[];
}

/** POST /api/imports/s3 — listing request. Credentials are used for the
 * listing and NEVER stored; confirm carries them once more for the copy. */
export interface S3ManifestRequest {
  url: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  prefix?: string;
}

/** One revision link, as the Sources surface shows it. */
export interface SourceRevisionDto {
  id: string;
  successorType: string;
  successorId: string;
  predecessorType: string;
  predecessorId: string;
  status: 'auto' | 'proposed' | 'confirmed' | 'rejected' | 'manual';
  basis: {
    filename: string | null;
    revisionNew: string | null;
    revisionOld: string | null;
    subjectOverlap: number | null;
    classMatch: boolean | null;
    shingleSimilarity: number | null;
    confidence: 'high' | 'medium' | 'manual';
  } | null;
  createdAt: string;
  decidedAt: string | null;
}
