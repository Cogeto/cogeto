#!/usr/bin/env node
/**
 * check-i18n.mjs — the locale guard (V2.0 item 3.5, Issue D points 1 and 2).
 * Runs inside `npm run lint`, so it is part of the required `lint` check.
 *
 * Four checks, each reporting the EXACT offending keys, per locale, per
 * namespace. A build fails on any of them:
 *
 *  1. KEY SYNC. Every base key in `en` exists in every other locale, and no
 *     locale carries a key `en` does not have. Namespaces must match too, so a
 *     new namespace cannot land in one locale only.
 *
 *  2. PLURAL COMPLETENESS. A key that is plural in `en` must carry exactly the
 *     plural categories the locale's OWN CLDR rules require. Croatian needs
 *     one/few/other where English needs one/other, so a literal key-for-key
 *     comparison would be wrong; this is the honest version of that rule.
 *
 *  3. PLACEHOLDER PARITY. Every `{{variable}}` and every `<tag>` in the English
 *     value must appear in the translated value. A dropped placeholder renders
 *     as a literal `{{count}}` to a user, which no reviewer would catch by eye
 *     in a language they do not read.
 *
 *  4. HOUSE STYLE. No em or en dash in any ENGLISH source value (the same rule
 *     `copy/no-typographic-dashes` enforces over the code, extended to the
 *     locale files, which ESLint does not parse).
 *
 *  5. SOURCE DRIFT (V2.5 item 8.3 follow-up). Checks 1 to 3 compare KEY SETS
 *     and placeholders; none of them looks at whether the words are current.
 *     `i18n:sync` seeds a new key with the English text and then never
 *     overwrites a value, so REWORDING an English string silently left every
 *     other locale serving the previous wording, with a green build. This
 *     catches it: an unregistered value must equal today's English, and a
 *     registered translation must still name the English it was made from.
 *     See `.translations.json` beside each locale root.
 *
 * Plus HYGIENE, reported the same way:
 *
 *  5. UNUSED KEYS. A key present in `en` that no source file references.
 *  6. HARDCODED LITERALS. User-visible text in the SPA that never went through
 *     `t()`. See `literalFindings` for exactly what this does and does not
 *     catch; it is a heuristic and says so.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  SOURCE_LOCALE,
  baseKey,
  englishFor,
  existingRoots,
  flatten,
  localesIn,
  namespacesIn,
  pluralCategoriesFor,
  pluralCategory,
  readNamespace,
  readTranslations,
  registeredSource,
} from './i18n-keys.mjs';

const problems = [];
const fail = (message) => problems.push(message);

// ── 1-4: per-root locale checks ──────────────────────────────────────────────

const EN_EM_DASH = /[–—]/;
/** `{{name}}` interpolations and `<tag>` markup slots, both order-independent. */
function placeholders(value) {
  if (typeof value !== 'string') return new Set();
  const found = new Set();
  for (const m of value.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)) found.add(`{{${m[1]}}}`);
  for (const m of value.matchAll(/<\/?([A-Za-z][\w-]*)\s*\/?>/g)) found.add(`<${m[1]}>`);
  return found;
}

/** The English keys actually referenced anywhere, collected for check 5. */
const referencedKeys = new Set();

for (const root of existingRoots()) {
  const locales = localesIn(root);
  const register = readTranslations(root);
  if (!locales.includes(SOURCE_LOCALE)) {
    fail(`${root}: no "${SOURCE_LOCALE}" locale — English is the source of truth.`);
    continue;
  }
  const sourceNamespaces = namespacesIn(root, SOURCE_LOCALE);

  for (const locale of locales) {
    const namespaces = namespacesIn(root, locale);
    for (const missing of sourceNamespaces.filter((n) => !namespaces.includes(n))) {
      fail(`${root}/${locale}: missing namespace file "${missing}.json"`);
    }
    for (const extra of namespaces.filter((n) => !sourceNamespaces.includes(n))) {
      fail(`${root}/${locale}: orphaned namespace file "${extra}.json" (no ${SOURCE_LOCALE} twin)`);
    }
  }

  for (const namespace of sourceNamespaces) {
    const source = flatten(readNamespace(root, SOURCE_LOCALE, namespace));

    // 4. House style, English source values only.
    for (const [key, value] of source) {
      if (typeof value === 'string' && EN_EM_DASH.test(value)) {
        const which = value.includes('—') ? 'em dash' : 'en dash';
        fail(
          `${root}/${SOURCE_LOCALE}/${namespace}.json: ${which} in "${key}". ` +
            'Rewrite with a comma, colon, period, or a restructured sentence.',
        );
      }
    }

    const sourceBases = new Map();
    for (const [key, value] of source) {
      const base = baseKey(key);
      if (!sourceBases.has(base)) {
        sourceBases.set(base, { plural: pluralCategory(key) !== null, value });
      }
      // Prefer `_other` as the placeholder reference: it is the general form.
      if (pluralCategory(key) === 'other') sourceBases.get(base).value = value;
    }

    for (const locale of locales) {
      if (locale === SOURCE_LOCALE) continue;
      if (!namespacesIn(root, locale).includes(namespace)) continue;
      const target = flatten(readNamespace(root, locale, namespace));
      const targetKeys = new Set(target.keys());
      const targetBases = new Set([...targetKeys].map(baseKey));
      const categories = pluralCategoriesFor(locale);

      // 1. Key sync, on BASE keys.
      for (const base of sourceBases.keys()) {
        if (!targetBases.has(base)) {
          fail(`${root}/${locale}/${namespace}.json: MISSING key "${base}"`);
        }
      }
      for (const base of targetBases) {
        if (!sourceBases.has(base)) {
          fail(
            `${root}/${locale}/${namespace}.json: ORPHANED key "${base}" ` +
              `(absent from ${SOURCE_LOCALE})`,
          );
        }
      }

      // 2. Plural completeness, per the locale's own CLDR rules.
      for (const [base, meta] of sourceBases) {
        if (!meta.plural || !targetBases.has(base)) continue;
        for (const category of categories) {
          if (!targetKeys.has(`${base}_${category}`)) {
            fail(
              `${root}/${locale}/${namespace}.json: MISSING plural form ` +
                `"${base}_${category}" (${locale} needs ${categories.join('/')})`,
            );
          }
        }
        for (const key of targetKeys) {
          const category = pluralCategory(key);
          if (category && baseKey(key) === base && !categories.includes(category)) {
            fail(
              `${root}/${locale}/${namespace}.json: UNUSED plural form "${key}" ` +
                `(${locale} has no "${category}" category)`,
            );
          }
        }
      }

      // 5. Source drift: are these words still the English they came from?
      for (const [key, value] of target) {
        const english = englishFor(source, key);
        if (typeof english !== 'string' || typeof value !== 'string') continue;
        const registered = registeredSource(register, locale, namespace, key);
        if (registered === undefined) {
          // Unregistered means "not translated", and an untranslated value is
          // the English text. Anything else is the previous wording, left
          // behind by a reword that `i18n:sync` had no mandate to overwrite.
          if (value !== english) {
            fail(
              `${root}/${locale}/${namespace}.json: STALE "${key}" holds text that is not the ` +
                `current English and is not registered as a translation.\n` +
                `      english now: ${JSON.stringify(english)}\n` +
                `      this locale: ${JSON.stringify(value)}\n` +
                '      Fix: `npm run i18n:sync -- --refresh` to take the new English, or ' +
                '`npm run i18n:sync -- --register` if it is a real translation.',
            );
          }
        } else if (registered !== english) {
          // A genuine translation whose source moved: the words still read
          // fine, and they now translate something English no longer says.
          fail(
            `${root}/${locale}/${namespace}.json: OUTDATED translation "${key}" — the English ` +
              `it was made from has changed.\n` +
              `      translated from: ${JSON.stringify(registered)}\n` +
              `      english now:     ${JSON.stringify(english)}\n` +
              '      Fix: retranslate, then `npm run i18n:sync -- --register`.',
          );
        }
      }

      // 3. Placeholder parity.
      for (const [key, value] of target) {
        const reference = sourceBases.get(baseKey(key));
        if (!reference) continue;
        const expected = placeholders(reference.value);
        const actual = placeholders(value);
        for (const token of expected) {
          if (!actual.has(token)) {
            fail(
              `${root}/${locale}/${namespace}.json: "${key}" dropped the placeholder ` +
                `${token}. Every {{variable}} and <tag> must survive translation verbatim.`,
            );
          }
        }
      }
    }
  }
}

// ── Source scan: what the code actually references ───────────────────────────

const SOURCE_DIRS = ['project/web/src', 'project/src'];
const SOURCE_EXT = ['.ts', '.tsx'];

function sourceFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist' || entry === 'locales') continue;
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (SOURCE_EXT.some((ext) => entry.endsWith(ext))) out.push(path);
  }
  return out;
}

const files = SOURCE_DIRS.flatMap((dir) => sourceFiles(dir));
const sources = new Map(files.map((path) => [path, readFileSync(path, 'utf8')]));

/**
 * Key references, in every form the codebase uses:
 *
 *   t('ns:a.b')  t('a.b')  i18next.t('ns:a.b')  i18nKey="a.b"  'a.b' in a map
 *
 * A TEMPLATE key (`t(`status.${value}`)`) is recorded as its literal PREFIX,
 * so every key under that prefix counts as referenced. That is deliberate: the
 * alternative is deleting a live key because a static scan could not evaluate a
 * variable. Enum maps are the reason the prefix form exists at all.
 */
const literalKeyRe = /\bt\(\s*['"]([\w.:-]+)['"]|i18nKey=\{?["']([\w.:-]+)["']/g;
const templateKeyRe = /\bt\(\s*`([\w.:-]*?)\$\{/g;
/** The server catalogue's call shape: serverT(locale, namespace, 'key', …). */
const serverKeyRe = /\bserverT\(\s*[^,]+,\s*['"][\w-]+['"]\s*,\s*['"]([\w.:-]+)['"]/g;
const serverTemplateRe = /\bserverT\(\s*[^,]+,\s*['"][\w-]+['"]\s*,\s*`([\w.:-]*?)\$\{/g;
const prefixes = new Set();

for (const text of sources.values()) {
  for (const m of text.matchAll(literalKeyRe)) referencedKeys.add(m[1] ?? m[2]);
  for (const m of text.matchAll(serverKeyRe)) referencedKeys.add(m[1]);
  for (const m of text.matchAll(templateKeyRe)) prefixes.add(m[1]);
  for (const m of text.matchAll(serverTemplateRe)) prefixes.add(m[1]);
}
// Namespace strings appearing anywhere (e.g. `t(FILE_STATE_KEY[state])`) can
// only be resolved by prefix, so also treat any quoted dotted string that looks
// like a key path as a reference.
const looseKeyRe = /['"`]([a-z][\w-]*(?::[\w.-]+)?(?:\.[\w-]+)+)['"`]/g;
for (const text of sources.values()) {
  for (const m of text.matchAll(looseKeyRe)) referencedKeys.add(m[1]);
}

function isReferenced(namespace, key) {
  const candidates = [key, `${namespace}:${key}`];
  if (candidates.some((c) => referencedKeys.has(c))) return true;
  return [...prefixes].some((prefix) => {
    const bare = prefix.includes(':') ? prefix.split(':')[1] : prefix;
    const ns = prefix.includes(':') ? prefix.split(':')[0] : null;
    if (ns !== null && ns !== namespace) return false;
    return bare !== '' && key.startsWith(bare);
  });
}

// ── 5: unused keys ───────────────────────────────────────────────────────────

for (const root of existingRoots()) {
  for (const namespace of namespacesIn(root, SOURCE_LOCALE)) {
    for (const key of flatten(readNamespace(root, SOURCE_LOCALE, namespace)).keys()) {
      if (!isReferenced(namespace, baseKey(key))) {
        fail(
          `${root}/${SOURCE_LOCALE}/${namespace}.json: UNUSED key "${key}" ` +
            '(referenced nowhere). Delete it, or reference it.',
        );
      }
    }
  }
}

// ── 6: hardcoded literals in the SPA (heuristic, honestly scoped) ────────────

/**
 * WHAT THIS CATCHES: multi-word English JSX text between tags, and multi-word
 * English strings assigned to the attributes that render text
 * (`placeholder`, `title`, `aria-label`, `alt`, `label`), in
 * project/web/src, outside specs.
 *
 * WHAT THIS DOES NOT CATCH, stated plainly rather than papered over:
 *
 *  - single words ("Save", "Cancel"): indistinguishable from identifiers,
 *    class names, enum values and CSS tokens at this level of analysis;
 *  - text built at runtime from variables;
 *  - strings passed as ordinary function arguments or object values;
 *  - anything outside the SPA.
 *
 * It is a regression net for the common shape of a reintroduced literal, not a
 * proof of coverage. Key sync (check 1) and the missing-key reporter are the
 * checks that carry weight; this one raises the floor.
 */
const TEXT_ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt', 'label'];
const jsxTextRe = />\s*([A-Z][A-Za-z'’,.!?:;-]*(?:\s+[A-Za-z'’,.!?:;-]+){2,})\s*</g;
const attrRe = new RegExp(
  `\\b(${TEXT_ATTRIBUTES.join('|')})=["']([A-Za-z][^"']*\\s+[^"']*\\s+[^"']*)["']`,
  'g',
);

function literalFindings(path, text) {
  const found = [];
  for (const m of text.matchAll(jsxTextRe)) found.push(`JSX text "${m[1].trim()}"`);
  for (const m of text.matchAll(attrRe)) found.push(`${m[1]}="${m[2]}"`);
  return found.map((what) => `${path}: hardcoded ${what}`);
}

for (const [path, text] of sources) {
  if (!path.startsWith('project/web/src')) continue;
  if (/\.spec\.tsx?$/.test(path)) continue;
  for (const finding of literalFindings(relative('.', path), text)) fail(finding);
}

// ── Report ───────────────────────────────────────────────────────────────────

if (problems.length > 0) {
  console.error(`check-i18n: ${problems.length} problem(s).\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('\nSee docs/features/i18n.md for the rules and the translator workflow.');
  process.exit(1);
}

const summary = existingRoots()
  .map((root) => `${root}: ${localesIn(root).join(', ')}`)
  .join(' · ');
console.log(`check-i18n: locales in sync (${summary}).`);
