import i18next from 'i18next';
import type { i18n as I18nInstance, Resource } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { SUPPORTED_LANGUAGES, isSupportedLanguage } from '@cogeto/shared';
import type { PreferredLanguage } from '@cogeto/shared';
import { DEFAULT_NAMESPACE, NAMESPACES } from './namespaces';
import { installMissingKeyReporter, isI18nDebugEnabled } from './missing-keys';

/**
 * The SPA's internationalisation runtime (V2.0 item 3.5, Issue A).
 *
 * Rules this file exists to keep true:
 *
 *  - English is the DEFAULT and the FALLBACK for every missing key, in every
 *    locale. A locale that has not been translated yet still renders correctly.
 *  - The active language comes from the user's `preferred_language` setting.
 *    The browser preference is only the default BEFORE a user preference is
 *    known (the login screen, a first paint); it never overrides an explicit
 *    choice. There is deliberately no `i18next-browser-languagedetector`.
 *  - Changing the language in Settings applies WITHOUT a page reload:
 *    `applyLanguage` loads the bundle and calls `changeLanguage`, and every
 *    component re-renders through react-i18next's context.
 *
 * Loading: `en` is bundled eagerly because it is the fallback and must always
 * be resident. Every other locale is a lazy chunk, fetched the first time it is
 * selected, so a monolingual instance never downloads three unused locales.
 */

type LocaleModules = Record<string, () => Promise<unknown>>;

/** en is the fallback for every key: always resident, never a lazy chunk. */
const EN_BUNDLES = import.meta.glob('../locales/en/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, Record<string, unknown>>;

/**
 * Every locale EXCEPT en: one chunk per namespace, fetched on first use.
 * Excluding `en` explicitly matters: a file that is both eagerly and lazily
 * imported cannot be split into its own chunk, so the lazy import would be
 * ineffective and every locale would land in the main bundle.
 */
const LAZY_BUNDLES = import.meta.glob(['../locales/*/*.json', '!../locales/en/*.json'], {
  import: 'default',
}) as LocaleModules;

/** `../locales/de/review.json` → `{ locale: 'de', namespace: 'review' }`. */
function parsePath(path: string): { locale: string; namespace: string } | null {
  const match = /\/locales\/([^/]+)\/([^/]+)\.json$/.exec(path);
  return match ? { locale: match[1]!, namespace: match[2]! } : null;
}

function englishResources(): Resource {
  const bundle: Record<string, Record<string, unknown>> = {};
  for (const [path, value] of Object.entries(EN_BUNDLES)) {
    const parsed = parsePath(path);
    if (parsed?.locale === 'en') bundle[parsed.namespace] = value;
  }
  return { en: bundle };
}

const loaded = new Set<string>(['en']);

/**
 * Fetch every namespace of a locale and register it. Idempotent, and a no-op
 * for `en` (already resident). A namespace whose chunk fails to load simply
 * stays absent, and its keys fall back to English rather than rendering raw.
 */
export async function loadLocale(locale: PreferredLanguage): Promise<void> {
  if (loaded.has(locale)) return;
  const entries = Object.entries(LAZY_BUNDLES).filter(
    ([path]) => parsePath(path)?.locale === locale,
  );
  await Promise.all(
    entries.map(async ([path, load]) => {
      const parsed = parsePath(path);
      if (!parsed) return;
      const value = (await load()) as Record<string, unknown>;
      i18next.addResourceBundle(locale, parsed.namespace, value, true, true);
    }),
  );
  loaded.add(locale);
}

/**
 * The browser's preference, narrowed to a locale Cogeto ships. Used ONLY as the
 * pre-login default; a stored user preference always wins over it.
 */
export function browserLocale(): PreferredLanguage {
  const candidates =
    typeof navigator === 'undefined'
      ? []
      : [...(navigator.languages ?? []), navigator.language].filter(Boolean);
  for (const candidate of candidates) {
    const base = candidate.split('-')[0]?.toLowerCase();
    if (isSupportedLanguage(base)) return base;
  }
  return 'en';
}

/**
 * Initialise i18next. Synchronous by construction (`initAsync: false` with
 * inline resources; the option was `initImmediate` before i18next 26, which
 * removed the old name rather than mapping it) so the first render already
 * has English in hand and no surface ever paints a raw key.
 *
 * Idempotent, and invoked once at the bottom of this module: importing the i18n
 * runtime anywhere (a component, a pure model, a spec) is enough to get a ready
 * instance. Nothing has to remember to bootstrap it first, which is exactly the
 * failure mode that would show up as a raw key on one surface only.
 */
export function initI18n(language: PreferredLanguage = 'en'): I18nInstance {
  if (i18next.isInitialized) return i18next;
  const debug = isI18nDebugEnabled();
  void i18next.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    supportedLngs: [...SUPPORTED_LANGUAGES],
    ns: [...NAMESPACES],
    defaultNS: DEFAULT_NAMESPACE,
    fallbackNS: DEFAULT_NAMESPACE,
    resources: englishResources(),
    // Vite already escapes; React escapes again on render. Double-escaping
    // turns an apostrophe in copy into `&#39;`, so it is off, as react-i18next
    // documents for React call sites.
    interpolation: { escapeValue: false },
    // Named variables only: `{{count}}`, never `{0}`. Nesting stays on so a
    // shared word (a product name, a status label) can be reused inside a
    // sentence without assembling it from fragments at the call site.
    initAsync: false,
    returnNull: false,
    // Loud missing keys in development (Issue B): the key renders wrapped in
    // guillemets so a gap is impossible to mistake for copy.
    saveMissing: debug,
    parseMissingKeyHandler: debug ? (key: string) => `«${key}»` : undefined,
  });
  if (debug) installMissingKeyReporter(i18next);
  return i18next;
}

/**
 * Switch the interface language, loading the bundle first. Safe to call with
 * the current language (a no-op) and safe to call on every render.
 */
export async function applyLanguage(locale: PreferredLanguage): Promise<void> {
  if (i18next.language === locale) return;
  await loadLocale(locale);
  await i18next.changeLanguage(locale);
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

/** The active interface locale, always one Cogeto ships. */
export function activeLocale(): PreferredLanguage {
  const language = i18next.resolvedLanguage ?? i18next.language;
  return isSupportedLanguage(language) ? language : 'en';
}

// English is inline, so this completes synchronously.
initI18n();

export { i18next };
