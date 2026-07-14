/**
 * Memory Passport DTOs (§B.5) — the API surface for the export mechanism.
 *
 * The Passport itself (the downloadable artifact) is an OPEN, versioned format
 * documented in `docs/passport-schema/`; these types are only the request/status
 * envelope the SPA talks to. `PASSPORT_VERSION` is the format version stamped
 * into every manifest — third parties read the schema for that version.
 */

/** The published format version. Bump on any breaking schema change. */
export const PASSPORT_VERSION = '1.0';

/**
 * Export lifecycle: `pending` while the worker assembles it, `ready` when the
 * signed artifact is downloadable, `failed` on error, `expired` once the
 * short-lived object has been swept.
 */
export const PASSPORT_EXPORT_STATUSES = ['pending', 'ready', 'failed', 'expired'] as const;
export type PassportExportStatus = (typeof PASSPORT_EXPORT_STATUSES)[number];

/** POST /api/passport/exports — trigger an export. */
export interface PassportExportRequest {
  /**
   * Include the original bytes of the user's uploaded files as attachments
   * (a full archive). Default false: reference-only (metadata + provenance).
   */
  includeOriginals?: boolean;
}

/** One export request's state (GET status / list). */
export interface PassportExportDto {
  id: string;
  status: PassportExportStatus;
  /** The format version this artifact was written in. */
  passportVersion: string;
  includeOriginals: boolean;
  /** Suggested download filename, e.g. `cogeto-passport-2026-07-14.zip`. */
  filename: string;
  /** Bytes of the assembled artifact; null until ready. */
  sizeBytes: number | null;
  createdAt: string;
  readyAt: string | null;
  /** A short, non-sensitive reason when status is `failed`. */
  error: string | null;
}

/** GET /api/passport/exports/:id/download — a short-lived signed URL. */
export interface PassportDownloadDto {
  url: string;
  expiresInSeconds: number;
}
