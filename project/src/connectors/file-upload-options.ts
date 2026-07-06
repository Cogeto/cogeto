/**
 * File-upload knobs the composition root supplies from validated config (only
 * entrypoints read the environment; modules receive options). Kept in its own
 * file so the interceptor and the service share the token without a cycle.
 */
export interface FileUploadOptions {
  /** Hard cap on a single upload; enforced by multer AND re-checked server-side. */
  uploadMaxBytes: number;
  /** Lifetime of a presigned download URL (§A.9 — short-lived). */
  downloadUrlTtlSeconds: number;
}

export const FILE_UPLOAD_OPTIONS = Symbol('FILE_UPLOAD_OPTIONS');
