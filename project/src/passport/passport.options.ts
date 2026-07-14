/** DI token + shape for the passport module's composition-root options. */
export const PASSPORT_OPTIONS = Symbol('PASSPORT_OPTIONS');

/** Default retention for a ready export's short-lived object (hours). */
export const PASSPORT_EXPORT_RETENTION_HOURS = 24;

export interface PassportOptions {
  /** Where the instance signing keypair lives — the worker signs the manifest
   * with the private half (decision 0008); the app never needs it. */
  instanceKeyDir: string;
  /** TTL of the presigned download URL (seconds) — mirrors file downloads. */
  downloadUrlTtlSeconds: number;
  /** How long a ready export's object is retained before the retention pass
   * deletes it (the "short-lived downloadable" promise, §B.5). */
  exportRetentionHours: number;
}
