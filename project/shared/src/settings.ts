import type { MemoryScope } from './memory';

/** Per-user capture/upload defaults (§A.9; O1-C Settings surface). */
export interface UserSettingsDto {
  /** Extract-and-discard: keep no original after extraction (per-upload override). */
  discardByDefault: boolean;
  /** Default scope for new captures/uploads (private|shared). */
  defaultScope: MemoryScope;
}

/** PUT /api/settings — partial update; omitted fields are unchanged. */
export type UpdateUserSettingsRequest = Partial<UserSettingsDto>;
