import type { MemoryScope } from './memory';

/** Per-user, per-space capture/upload defaults (Settings surface; the space
 * dimension is the settings split, docs/features/spaces.md section 4). */
export interface UserSettingsDto {
  /** Extract-and-discard: keep no original after extraction (per-upload override). */
  discardByDefault: boolean;
  /** Default scope for new captures/uploads (private|shared). */
  defaultScope: MemoryScope;
  /** Auto-research: a knowledge answer that would offer web research just
   * does it. Research behaviour is content behaviour, so per space. */
  autoResearch: boolean;
}

/** PUT /api/settings — partial update; omitted fields are unchanged. */
export type UpdateUserSettingsRequest = Partial<UserSettingsDto>;
