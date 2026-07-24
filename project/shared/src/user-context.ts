/**
 * Per-user instance context (P6.6, decision 0051) and language preference
 * (decision 0052). All fields are optional except the language pair, which
 * always has a value (defaults: en, mirroring on). `timezone` is null when the
 * user has not overridden the instance timezone (QS-32); the effective zone is
 * surfaced separately so the UI can show what actually applies.
 */

/** The locale codes Cogeto speaks today. Deliberately the future i18n key. */
export const SUPPORTED_LANGUAGES = ['en', 'hr'] as const;
export type PreferredLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export interface UserContextDto {
  /** How Cogeto addresses the user. Null = unset (absent from prompts). */
  displayName: string | null;
  company: string | null;
  roleTitle: string | null;
  /** One free-text line about the user's work. */
  aboutWork: string | null;
  /** Per-user IANA zone override; null = the instance timezone applies. */
  timezone: string | null;
  /** The zone actually in effect (user override or the instance default). */
  effectiveTimezone: string;
  preferredLanguage: PreferredLanguage;
  /** Strict mode: replies always in preferredLanguage, never mirrored. */
  languageStrict: boolean;
  /** Provenance of an accepted suggestion (decision 0053); null = user-typed. */
  companySourceMemoryId: string | null;
  roleTitleSourceMemoryId: string | null;
}

/**
 * PUT /api/settings/context — partial update; omitted fields are unchanged,
 * explicit null clears a field.
 */
export interface UpdateUserContextRequest {
  displayName?: string | null;
  company?: string | null;
  roleTitle?: string | null;
  aboutWork?: string | null;
  timezone?: string | null;
  preferredLanguage?: PreferredLanguage;
  languageStrict?: boolean;
}

/** The fields the derivation loop may propose (decision 0053). */
export type SuggestibleContextField = 'company' | 'roleTitle';

export interface ContextSuggestionDto {
  field: SuggestibleContextField;
  value: string;
  /** The memory the value was derived from — shown as the source. */
  sourceMemoryId: string;
  /** ISO date of the suggesting memory, for "from your note of 12 May". */
  sourceDate: string;
  /** Human label of the source kind, e.g. "note", "email". */
  sourceLabel: string;
}

export interface ContextSuggestionsDto {
  suggestions: ContextSuggestionDto[];
}

/** POST /api/settings/context/suggestions/accept | dismiss */
export interface ContextSuggestionActionRequest {
  field: SuggestibleContextField;
  value: string;
  sourceMemoryId: string;
}
