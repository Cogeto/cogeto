import { LOCALE_TAGS } from '@cogeto/shared';
import type { PreferredLanguage } from '@cogeto/shared';
import { activeLocale, i18next } from './index';

/**
 * The ONE place the SPA turns a value into displayed text (V2.0 item 3.5,
 * Issue C point 3).
 *
 * Before this, the app called `toLocaleDateString()` with no locale in a dozen
 * places (so it followed the BROWSER, not the user's choice) and hardcoded
 * `en-GB` in one (the audit finding). Both are wrong once the interface has a
 * language: a German interface that renders dates in the browser's Japanese is
 * not localised, it is inconsistent.
 *
 * Every formatter takes the ACTIVE INTERFACE LOCALE, mapped to a BCP-47 tag by
 * `LOCALE_TAGS`. `en` maps to `en-GB`, which is what the one hardcoded site
 * already produced, so English renders byte-identically to before.
 *
 * Timezone is deliberately untouched: instance-context timezone handling
 * (V2.0 item 3.3's now-block) is server-side and unchanged by this work.
 */

function tag(locale?: PreferredLanguage): string {
  return LOCALE_TAGS[locale ?? activeLocale()];
}

/** `12 May 2026` — a date with no time. */
export function formatDate(iso: string | Date, locale?: PreferredLanguage): string {
  return new Intl.DateTimeFormat(tag(locale), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(toDate(iso));
}

/** `12 May` — day and month only, for compact citation chips. */
export function formatDayMonth(iso: string | Date, locale?: PreferredLanguage): string {
  return new Intl.DateTimeFormat(tag(locale), { month: 'short', day: 'numeric' }).format(
    toDate(iso),
  );
}

/** `12 May 2026` in long month form, for the context-suggestion sentence. */
export function formatLongDayMonth(iso: string | Date, locale?: PreferredLanguage): string {
  return new Intl.DateTimeFormat(tag(locale), { day: 'numeric', month: 'long' }).format(
    toDate(iso),
  );
}

/** `12/05/2026` — the short numeric date the list rows fall back to. */
export function formatShortDate(iso: string | Date, locale?: PreferredLanguage): string {
  return new Intl.DateTimeFormat(tag(locale)).format(toDate(iso));
}

/** `12/05/2026, 14:32` — date and time, the `toLocaleString()` replacement. */
export function formatDateTime(iso: string | Date, locale?: PreferredLanguage): string {
  return new Intl.DateTimeFormat(tag(locale), {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(toDate(iso));
}

/** `14:32` — clock time only. */
export function formatTime(iso: string | Date, locale?: PreferredLanguage): string {
  return new Intl.DateTimeFormat(tag(locale), { timeStyle: 'short' }).format(toDate(iso));
}

/** Grouped digits: `1,204` in English, `1.204` in German. */
export function formatNumber(value: number, locale?: PreferredLanguage): string {
  return new Intl.NumberFormat(tag(locale)).format(value);
}

/**
 * `81.9%` — a measured fraction as a percentage, locale-formatted (V2.4 item
 * 7.1). One decimal, because a trust score's second decimal is noise and its
 * first is not.
 */
export function formatPercent(fraction: number, locale?: PreferredLanguage): string {
  return new Intl.NumberFormat(tag(locale), {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(fraction);
}

/**
 * `640 KB` / `2.4 MB`, with the number itself locale-formatted. Binary units,
 * matching what the upload limits are actually expressed in.
 */
export function formatFileSize(bytes: number | null | undefined, locale?: PreferredLanguage) {
  if (bytes == null) return null;
  const l = locale ?? activeLocale();
  if (bytes < 1024) {
    return i18next.t('common:fileSize.bytes', { count: bytes, value: formatNumber(bytes, l) });
  }
  if (bytes < 1024 * 1024) {
    return i18next.t('common:fileSize.kilobytes', {
      value: new Intl.NumberFormat(tag(l), { maximumFractionDigits: 0 }).format(bytes / 1024),
    });
  }
  return i18next.t('common:fileSize.megabytes', {
    value: new Intl.NumberFormat(tag(l), {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(bytes / (1024 * 1024)),
  });
}

/**
 * Relative timestamp for list rows, with the exact date on hover at the call
 * site. Falls back to an absolute date past 30 days, where "42 d ago" stops
 * being the useful thing to read.
 *
 * The unit strings are plural keys, so Croatian gets its `one/few/other` forms
 * (`1 minuta`, `3 minute`, `7 minuta`) that English does not need. This is why
 * the key-sync check compares BASE keys and then checks each locale's plural
 * categories against its own CLDR rules, instead of demanding identical key
 * sets across locales.
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.floor((now - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return i18next.t('common:relativeTime.justNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return i18next.t('common:relativeTime.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return i18next.t('common:relativeTime.hours', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return i18next.t('common:relativeTime.days', { count: days });
  return formatShortDate(iso);
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}
