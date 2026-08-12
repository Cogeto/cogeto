/**
 * Shared locale-file helpers for the i18n checks and the scaffolding command
 * (V2.0 item 3.5, Issue D). No dependencies: Node's built-ins and `Intl` only.
 *
 * Two roots carry locale files, and both are governed by the same rules:
 *
 *   project/web/src/locales/<locale>/<namespace>.json          the SPA
 *   project/src/infrastructure/locales/<locale>/<ns>.json      server-side copy
 *
 * `en` is authoritative in both. Every other locale must carry exactly the same
 * BASE keys, plus the plural forms ITS OWN language needs.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Every locale root, in the order the checks report them. */
export const LOCALE_ROOTS = ['project/web/src/locales', 'project/src/infrastructure/locales'];

export const SOURCE_LOCALE = 'en';

/** The CLDR plural suffixes i18next appends. Order is CLDR's, not alphabetical. */
export const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'];

const PLURAL_RE = new RegExp(`_(${PLURAL_SUFFIXES.join('|')})$`);

/** `relativeTime.minutes_other` → `relativeTime.minutes`; other keys unchanged. */
export function baseKey(key) {
  return key.replace(PLURAL_RE, '');
}

/** The plural category of a key, or null when the key is not a plural form. */
export function pluralCategory(key) {
  const match = PLURAL_RE.exec(key);
  return match ? match[1] : null;
}

/**
 * The plural categories a locale actually needs, from the runtime's own CLDR
 * data. Croatian needs one/few/other, French one/many/other, English and German
 * one/other. Hardcoding that table would rot; asking Intl cannot.
 */
export function pluralCategoriesFor(locale) {
  const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  // Sort into CLDR order so generated files read predictably.
  return PLURAL_SUFFIXES.filter((suffix) => categories.includes(suffix));
}

/** Flatten a nested locale object into dotted `a.b.c` → value entries. */
export function flatten(value, prefix = '', out = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      flatten(child, path, out);
    } else {
      out.set(path, child);
    }
  }
  return out;
}

/** Rebuild a nested object from dotted keys, so generated files stay readable. */
export function nest(entries) {
  const root = {};
  for (const [path, value] of entries) {
    const parts = path.split('.');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
      node = node[part];
    }
    node[parts[parts.length - 1]] = value;
  }
  return root;
}

function directories(path) {
  try {
    return readdirSync(path).filter((entry) => statSync(join(path, entry)).isDirectory());
  } catch {
    return [];
  }
}

/** The locales present under a root, `en` first. */
export function localesIn(root) {
  const found = directories(root);
  return [
    ...found.filter((l) => l === SOURCE_LOCALE),
    ...found.filter((l) => l !== SOURCE_LOCALE).sort(),
  ];
}

/** The namespace file names (without `.json`) of one locale. */
export function namespacesIn(root, locale) {
  try {
    return readdirSync(join(root, locale))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
  } catch {
    return [];
  }
}

/** Parse one namespace file; throws with the path when the JSON is invalid. */
export function readNamespace(root, locale, namespace) {
  const path = join(root, locale, `${namespace}.json`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

/**
 * The register of DELIBERATE translations, one file per locale root
 * (V2.5 item 8.3 follow-up).
 *
 * The invariant it exists to make checkable: **an untranslated value equals
 * the current English.** `i18n:sync` seeds every new key with the English
 * text and, by design, never overwrites a value afterwards, so rewording an
 * English string leaves every other locale holding the OLD English while the
 * key-set check still passes. Nothing caught that.
 *
 * A value may legitimately differ from English for exactly one reason: it was
 * translated. So a translated value is REGISTERED here, together with the
 * English it was made from, which makes both failures visible:
 *
 *  - unregistered and different from English → stale placeholder;
 *  - registered but the recorded English no longer matches → the source moved
 *    under a real translation, so it needs retranslating.
 *
 * Shape: `{ "<locale>": { "<namespace>": { "<flat.key>": "<english then>" } } }`.
 * It lives beside the locale directories rather than inside one, so a
 * translator's folder still holds nothing but their own namespace files.
 */
export const TRANSLATIONS_FILE = '.translations.json';

export function translationsPath(root) {
  return join(root, TRANSLATIONS_FILE);
}

export function readTranslations(root) {
  try {
    return JSON.parse(readFileSync(translationsPath(root), 'utf8'));
  } catch {
    return {};
  }
}

/** The English a key was translated from, or undefined when unregistered. */
export function registeredSource(register, locale, namespace, key) {
  return register?.[locale]?.[namespace]?.[key];
}

/**
 * The English value a target key should be compared against. A plural
 * category the source language does not have (Croatian `_few`, French
 * `_many`) has no English twin, so it falls back to English `_other`, which
 * is what `i18n:sync` seeded it from.
 */
export function englishFor(source, key) {
  if (source.has(key)) return source.get(key);
  const category = pluralCategory(key);
  if (category === null) return undefined;
  return source.get(`${baseKey(key)}_other`);
}

/** Every root that actually exists on disk (the server root is optional). */
export function existingRoots() {
  return LOCALE_ROOTS.filter((root) => localesIn(root).length > 0);
}
