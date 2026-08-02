/**
 * Per-user instance context and language preference
 *. All fields are optional except the language pair, which
 * always has a value (defaults: en, mirroring on). `timezone` is null when the
 * user has not overridden the instance timezone; the effective zone is
 * surfaced separately so the UI can show what actually applies.
 */

/**
 * The locale codes Cogeto speaks. This is the i18n key: it selects the
 * interface locale in the SPA (V2.0 item 3.5) and the language of everything
 * Cogeto writes on its own (digests, deterministic replies, conclusions).
 *
 * `en` is the default and the fallback for every missing interface key. Order
 * matters only for the settings list.
 *
 * INTERFACE LANGUAGE IS NOT EXTRACTION QUALITY. Memory quality is measured per
 * language, and only `en` and `hr` have golden corpora and gates today (spec
 * §14). `de` and `fr` are interface languages until corpora exist for them; the
 * trust page and docs/eval/gate-model.md say so in the same words.
 */
export const SUPPORTED_LANGUAGES = ['en', 'hr', 'de', 'fr'] as const;
export type PreferredLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * The subset with a golden corpus and published per-language gates. Everything
 * else renders the interface in its own language and falls back to English
 * where a translation is missing, but makes no measured quality claim.
 */
export const MEASURED_LANGUAGES = ['en', 'hr'] as const;
export type MeasuredLanguage = (typeof MEASURED_LANGUAGES)[number];

/** BCP-47 tag per locale, for Intl date, time and number formatting. */
export const LOCALE_TAGS: Record<PreferredLanguage, string> = {
  en: 'en-GB',
  hr: 'hr-HR',
  de: 'de-DE',
  fr: 'fr-FR',
};

/** Endonyms: a language is always listed in its own language. */
export const LANGUAGE_ENDONYMS: Record<PreferredLanguage, string> = {
  en: 'English',
  hr: 'Hrvatski',
  de: 'Deutsch',
  fr: 'Français',
};

export function isSupportedLanguage(value: unknown): value is PreferredLanguage {
  return (SUPPORTED_LANGUAGES as readonly unknown[]).includes(value);
}

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
  /** Provenance of an accepted suggestion; null = user-typed. */
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

/** The fields the derivation loop may propose. */
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
