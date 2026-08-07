import type { PreferredLanguage } from '@cogeto/shared';
import { SUPPORTED_LANGUAGES } from '@cogeto/shared';
import chatEn from './locales/en/chat.json';
import chatHr from './locales/hr/chat.json';
import chatDe from './locales/de/chat.json';
import chatFr from './locales/fr/chat.json';
import digestEn from './locales/en/digest.json';
import digestHr from './locales/hr/digest.json';
import digestDe from './locales/de/digest.json';
import digestFr from './locales/fr/digest.json';
import researchEn from './locales/en/research.json';
import researchHr from './locales/hr/research.json';
import researchDe from './locales/de/research.json';
import researchFr from './locales/fr/research.json';
import reportEn from './locales/en/report.json';
import reportHr from './locales/hr/report.json';
import reportDe from './locales/de/report.json';
import reportFr from './locales/fr/report.json';

/**
 * The server-side copy catalogue (V2.0 item 3.5, Issue C).
 *
 * Cogeto writes text of its own: the dreaming digest, the deterministic chat
 * replies, the research thread message. That copy reaches a user, so it follows
 * the SAME key discipline as the SPA: structural keys named by meaning and
 * location, named interpolation variables, plural forms per language, one
 * sentence per key. The files live at
 * `project/src/infrastructure/locales/<locale>/<namespace>.json`, inside the
 * module that owns them (a top-level `project/src/locales/` would read as a
 * bounded context to the module-boundary rules, spec §15), and are checked by
 * the same `npm run i18n:check` that governs the SPA's.
 *
 * Deliberately NOT i18next: the server needs key lookup, named interpolation
 * and CLDR plurals, which is ~40 lines against `Intl.PluralRules`. A second
 * runtime dependency would need owner sign-off and buy nothing.
 *
 * Language selection is UNCHANGED by this work. Everything Cogeto initiates
 * still speaks the user's `preferred_language`; a reply still mirrors the
 * language of the message it answers (`intent.lang`); strict mode still forces
 * the anchor. This module only moved where the words are stored.
 *
 * Strings that never reach a user (log lines, developer errors, prompt
 * assembly) stay exactly where they are: they are not copy.
 */

export const SERVER_NAMESPACES = ['digest', 'chat', 'research', 'report'] as const;
export type ServerNamespace = (typeof SERVER_NAMESPACES)[number];

type Catalogue = Record<string, unknown>;

const BUNDLES: Record<PreferredLanguage, Record<ServerNamespace, Catalogue>> = {
  en: { digest: digestEn, chat: chatEn, research: researchEn, report: reportEn },
  hr: { digest: digestHr, chat: chatHr, research: researchHr, report: reportHr },
  de: { digest: digestDe, chat: chatDe, research: researchDe, report: reportDe },
  fr: { digest: digestFr, chat: chatFr, research: researchFr, report: reportFr },
};

const PLURAL_RULES = new Map<PreferredLanguage, Intl.PluralRules>(
  SUPPORTED_LANGUAGES.map((locale) => [locale, new Intl.PluralRules(locale)]),
);

function lookup(bundle: Catalogue, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => {
    if (node !== null && typeof node === 'object' && part in node) {
      return (node as Record<string, unknown>)[part];
    }
    return undefined;
  }, bundle);
}

/** `{{name}}` → the named value. Positional placeholders do not exist here. */
function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

export interface ServerTOptions extends Record<string, string | number | undefined> {
  /** Selects the plural form via the LOCALE'S OWN CLDR rules, and interpolates. */
  count?: number;
}

/**
 * Resolve one key in one locale. Falls back to English for a key a locale has
 * not translated, so an untranslated language still produces correct text
 * rather than a raw key, exactly as the SPA does.
 */
export function serverT(
  locale: PreferredLanguage,
  namespace: ServerNamespace,
  key: string,
  options: ServerTOptions = {},
): string {
  const candidates: string[] = [];
  if (typeof options.count === 'number') {
    const category = (PLURAL_RULES.get(locale) ?? PLURAL_RULES.get('en')!).select(options.count);
    candidates.push(`${key}_${category}`, `${key}_other`);
  }
  candidates.push(key);

  for (const bundle of [BUNDLES[locale], BUNDLES.en]) {
    for (const candidate of candidates) {
      const value = lookup(bundle[namespace], candidate);
      if (typeof value === 'string') {
        const vars: Record<string, string | number> = {};
        for (const [name, v] of Object.entries(options)) if (v !== undefined) vars[name] = v;
        return interpolate(value, vars);
      }
    }
  }
  // A key with no English value is a defect the i18n check catches at build
  // time; at runtime, render the key rather than an empty string so it is
  // visible instead of silently missing.
  return key;
}

/** A translator bound to one locale and namespace, for a call site that uses many keys. */
export function serverTranslator(locale: PreferredLanguage, namespace: ServerNamespace) {
  return (key: string, options: ServerTOptions = {}) => serverT(locale, namespace, key, options);
}
