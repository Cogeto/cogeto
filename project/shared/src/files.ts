import type { MemoryScope } from './memory';

/** File upload DTOs (O1): POST /api/files and the per-file processing poll. */

/**
 * Extraction/pipeline progress, derived from the queue's own ledgers (same
 * mechanism as notes): `done` = the pipeline job's idempotency row exists;
 * `error` = the job is in the dead-letter table (e.g. a corrupt/unparseable
 * file); otherwise it is queued, extracting or deriving — surfaced as
 * `processing`.
 */
export type FileProcessingState = 'processing' | 'done' | 'error';

/** POST /api/files response — the object key IS the source id (1:1, F1 handoff). */
export interface FileUploadedDto {
  objectKey: string;
  /**
   * The bytes were already stored, so `objectKey` is the EXISTING source and
   * nothing was ingested a second time (issue #536). The surfaces say so
   * rather than showing a new row that is not there.
   */
  duplicate: boolean;
}

export interface FileStatusDto {
  state: FileProcessingState;
}

/** GET /api/files/:key — the source drawer's file facts (owner-only). */
export interface FileSourceDto {
  objectKey: string;
  filename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  scope: MemoryScope;
  sensitive: boolean;
  uploadDate: string;
  state: FileProcessingState;
  /**
   * Extract-and-discard: the original was deleted after extraction —
   * provenance and the derived memories remain, but there is nothing to
   * download. The drawer shows "original discarded after extraction".
   */
  discarded: boolean;
  /**
   * What the reading layer made of the file, or null when nothing has been
   * recorded yet (still queued, or a source that predates V2.1 item 4.1).
   */
  read: FileReadReportDto | null;
}

/**
 * What the reading layer made of the file (V2.1 item 4.1). Enum values, counts
 * and identifiers: the SPA maps `outcome` and `reasonCode` to translated copy
 * through explicit value → key maps, so no English sentence travels from the
 * server into the interface.
 *
 * `truncated` is a SUCCESS with a caveat, and the caveat is the point: a user
 * who uploaded a fifty-thousand-row workbook must be able to see that Cogeto
 * read part of it, rather than believe it read all of it.
 */
export type FileReadOutcome =
  | 'read'
  | 'truncated'
  | 'empty'
  | 'unsupported_format'
  | 'read_failed'
  /**
   * Pages that need a model that can see, on an instance that has none working
   * (V2.1 item 4.1). Not a property of the document: enable vision and the same
   * file reads. This is what the reprocess action exists for.
   */
  | 'needs_vision';

export interface FileReadSheetDto {
  name: string | null;
  index: number;
  rowsRead: number;
  rowsTotal: number;
  truncated: boolean;
}

export interface FileReadReportDto {
  format: string | null;
  outcome: FileReadOutcome;
  /** The specific reason, or null when the read was clean. */
  reasonCode: string | null;
  /** Statements (spreadsheets) or text segments (documents) produced. */
  segments: number;
  sheets: FileReadSheetDto[];
  /** Cells whose stored value could not be recovered (uncached formulas, errors). */
  valuesUnavailable: number;
  readAt: string;
  /** Pages read, by tier, and pages not read, with why (V2.1 item 4.1). */
  pages?: FileReadPageDto[];
  /** Pages escalated to the vision tier, so the cost is visible. */
  visionPagesUsed?: number;
}

export interface FileReadPageDto {
  page: number;
  /** `text`, `ocr`, `vision`, or null when the page was not read at all. */
  tier: string | null;
  reason: string | null;
}

/**
 * Sources that could not be read for want of a capability (V2.1 item 4.1).
 * Enabling vision on an instance should be followed by reading what it
 * previously could not, and that needs a list to work from.
 */
export interface AwaitingCapabilityDto {
  objectKey: string;
  filename: string | null;
  outcome: FileReadOutcome;
  reasonCode: string | null;
  readAt: string;
  /** Pages that would be retried. */
  pagesAwaiting: number;
}

/** GET /api/files/:key/download — a short-lived signed URL, owner-gated. */
export interface FileDownloadDto {
  url: string;
  expiresInSeconds: number;
}

/** The document types Cogeto accepts (validated at the boundary, mirrored in the UI). */
export const PDF_CONTENT_TYPE = 'application/pdf';
export const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** Spreadsheets (V2.1 item 4.1): the OOXML workbook and plain delimited text. */
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const CSV_CONTENT_TYPE = 'text/csv';
/**
 * Markdown and plain text (V2.5 item 8.2): a converted Confluence page uploads
 * as `text/markdown`, and `.txt` notes ride the same reader. Like CSV they
 * carry no magic bytes, so they are accepted on their declared label plus a
 * text-looking name; the `.csv`/`.tsv` alias below still outranks a
 * `text/plain` label for delimited files.
 */
export const MARKDOWN_CONTENT_TYPE = 'text/markdown';
export const PLAIN_TEXT_CONTENT_TYPE = 'text/plain';
/**
 * Standalone images (V2.1 item 4.1). A photograph of a page, a screenshot or an
 * exported diagram is a document: it goes through the reading ladder like any
 * scanned page, cheapest tier first.
 */
export const IMAGE_CONTENT_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/tiff',
];

/**
 * Types a browser genuinely sends for a `.csv`, mapped to the one Cogeto
 * stores. Windows reports `application/vnd.ms-excel` for a CSV whenever Excel
 * owns the extension, and several browsers fall back to `application/octet-
 * stream`; refusing those would refuse ordinary files for a reason no user can
 * act on. The bytes still decide: a declared type only ever selects a reader
 * when the magic bytes name no format of their own.
 */
export const CSV_ALIAS_CONTENT_TYPES: readonly string[] = [
  'application/csv',
  'text/plain',
  'application/vnd.ms-excel',
  'application/octet-stream',
];

export const ALLOWED_UPLOAD_CONTENT_TYPES: readonly string[] = [
  PDF_CONTENT_TYPE,
  DOCX_CONTENT_TYPE,
  XLSX_CONTENT_TYPE,
  CSV_CONTENT_TYPE,
  MARKDOWN_CONTENT_TYPE,
  PLAIN_TEXT_CONTENT_TYPE,
  ...IMAGE_CONTENT_TYPES,
];

/** Accept-friendly extensions for the file picker + client-side validation. */
export const ALLOWED_UPLOAD_EXTENSIONS: readonly string[] = [
  '.pdf',
  '.docx',
  '.xlsx',
  '.csv',
  '.md',
  '.markdown',
  '.txt',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.tif',
  '.tiff',
];

/** Default cap; the server's configurable ceiling (COGETO_UPLOAD_MAX_BYTES) wins. */
export const DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
