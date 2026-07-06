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
}

/** GET /api/files/:key/download — a short-lived signed URL (§A.9), owner-gated. */
export interface FileDownloadDto {
  url: string;
  expiresInSeconds: number;
}

/** The document types v1 accepts (validated at the boundary and mirrored in the UI). */
export const PDF_CONTENT_TYPE = 'application/pdf';
export const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const ALLOWED_UPLOAD_CONTENT_TYPES: readonly string[] = [
  PDF_CONTENT_TYPE,
  DOCX_CONTENT_TYPE,
];

/** Accept-friendly extensions for the file picker + client-side validation. */
export const ALLOWED_UPLOAD_EXTENSIONS: readonly string[] = ['.pdf', '.docx'];

/** Default cap; the server's configurable ceiling (COGETO_UPLOAD_MAX_BYTES) wins. */
export const DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
