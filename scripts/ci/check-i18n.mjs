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
 *  6. COMPLETENESS (F14). A locale Cogeto ships as supported must actually be
 *     translated. A value identical to its English source is either an
 *     untranslated placeholder or one of a small, explicit set of terms that
 *     are identical BY DESIGN (`i18n-identical.json`). The count is printed
 *     per locale on success, so a locale cannot drift back to scaffold state
 *     one merged pull request at a time.
 *
 *  7. SERVER ERROR CODES (F13). Every user-facing failure the server raises
 *     carries a code, and the interface holds one key per code. This reads the
 *     throw sites (`server-error-codes.mjs`) and holds the `serverErrors`
 *     namespace to them: no code without a key, no key without a code, and no
 *     English that has drifted from the sentence at the throw site.
 *
 * Plus HYGIENE, reported the same way:
 *
 *  5. UNUSED KEYS. A key present in `en` that no source file references.
 *  8. HARDCODED LITERALS. User-visible text that never went through `t()`:
 *     a heuristic in the SPA, and an exact rule on the server, where the only
 *     legal way to raise a failure is through `userError`/`untranslatedError`.
 *     See `literalFindings` for what the SPA half does and does not catch.
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
import {
  API_ERROR_FILE,
  NEST_EXCEPTION_RE,
  SERVER_ERROR_NAMESPACE,
  readServerErrorCodes,
  serverSourceFiles,
} from './server-error-codes.mjs';

const problems = [];
const fail = (message) => problems.push(message);

/** Terms that are the same word in every language. Deliberately small. */
const IDENTICAL = JSON.parse(readFileSync('scripts/ci/i18n-identical.json', 'utf8'));
const ROOT_TAG = {
  'project/web/src/locales': 'web',
  'project/src/infrastructure/locales': 'server',
};

/** Every allowlist entry that actually justified an identical value. */
const identicalUsed = new Set();

function identicalByDesign(root, locale, namespace, key) {
  const tag = ROOT_TAG[root];
  const base = baseKey(key);
  if ((IDENTICAL[tag]?.[namespace] ?? []).includes(base)) {
    identicalUsed.add(`${tag}/${namespace}/${base}`);
    return true;
  }
  if ((IDENTICAL.perLocale?.[locale]?.[tag]?.[namespace] ?? []).includes(base)) {
    identicalUsed.add(`${locale}/${tag}/${namespace}/${base}`);
    return true;
  }
  return false;
}

/** locale -> the values that are still their English source. */
const untranslated = new Map();
/** locale -> how many values that locale carries, for the coverage line. */
const localeTotals = new Map();

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
      // 6. Completeness: is this value translated at all?
      for (const [key, value] of target) {
        const english = englishFor(source, key);
        if (typeof english !== 'string' || typeof value !== 'string') continue;
        localeTotals.set(locale, (localeTotals.get(locale) ?? 0) + 1);
        if (value === english && !identicalByDesign(root, locale, namespace, key)) {
          untranslated.set(locale, [
            ...(untranslated.get(locale) ?? []),
            `${root}/${locale}/${namespace}.json: "${key}"`,
          ]);
        }
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
    // `serverErrors` is resolved at runtime from a code the server sends
    // (`t(`serverErrors:${error.code}`)`), so no static scan can see a
    // reference. Check 7 below proves every one of its keys is live by
    // matching it against an actual throw site, which is stronger.
    if (namespace === SERVER_ERROR_NAMESPACE) continue;
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

// ── 7: server error codes (F13) ──────────────────────────────────────────────

/**
 * The server's half of the same rule, and the one place this guard is EXACT
 * rather than heuristic.
 *
 * Every user-facing failure is raised through `userError`, which pairs a stable
 * code with the English sentence. The interface carries one `serverErrors` key
 * per code. Three ways that can go wrong, all fatal here:
 *
 *  - a code with no key: the interface would fall back to English;
 *  - a key with no code: dead copy a translator would waste time on;
 *  - a key whose English no longer matches the throw site: the translations
 *    were made from a sentence the server no longer sends.
 *
 * The English lives in two places on purpose (see `infrastructure/api-error.ts`
 * for why). This is what makes that safe.
 */
{
  const { codes, problems: readProblems } = readServerErrorCodes();
  for (const problem of readProblems) fail(problem);

  const root = 'project/web/src/locales';
  const expected = new Map();
  for (const [code, entry] of codes) {
    if (entry.forms.one === undefined) expected.set(code, entry.forms.other);
    else {
      expected.set(`${code}_one`, entry.forms.one);
      expected.set(`${code}_other`, entry.forms.other);
    }
  }
  const actual = flatten(readNamespace(root, SOURCE_LOCALE, SERVER_ERROR_NAMESPACE));
  const remedy = 'Run `npm run i18n:server-errors`, then `npm run i18n:sync`.';
  for (const [key, english] of expected) {
    if (!actual.has(key)) {
      fail(
        `${root}/${SOURCE_LOCALE}/${SERVER_ERROR_NAMESPACE}.json: MISSING key "${key}" for a ` +
          `code the server raises (${codes.get(baseKey(key)).file}:${codes.get(baseKey(key)).line}). ` +
          remedy,
      );
    } else if (actual.get(key) !== english) {
      fail(
        `${root}/${SOURCE_LOCALE}/${SERVER_ERROR_NAMESPACE}.json: "${key}" has drifted from the ` +
          `sentence at the throw site.\n` +
          `      throw site: ${JSON.stringify(english)}\n` +
          `      locale file: ${JSON.stringify(actual.get(key))}\n` +
          `      ${remedy}`,
      );
    }
  }
  for (const key of actual.keys()) {
    if (!expected.has(key)) {
      fail(
        `${root}/${SOURCE_LOCALE}/${SERVER_ERROR_NAMESPACE}.json: ORPHANED key "${key}" ` +
          `(no throw site raises that code). ${remedy}`,
      );
    }
  }
}

// ── 8a: no uncoded failure on the server (exact) ─────────────────────────────

/**
 * The literal scan used to stop at the SPA boundary, which is how 197 English
 * server sentences stayed invisible to it (F13). On the server the rule can be
 * exact rather than heuristic, because there is exactly one legal way to raise
 * an HTTP failure: `userError` (coded, translated) or `untranslatedError`
 * (declared not to be translated, for a developer error, a machine client, or
 * text we did not write). Constructing a Nest exception directly bypasses both,
 * so it is a build error.
 *
 * A single deliberate exception is allowed, on a line preceded by
 * `// i18n-exempt: <reason>`, which makes the decision reviewable in the diff.
 */
for (const file of serverSourceFiles()) {
  if (file === API_ERROR_FILE) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const [index, line] of lines.entries()) {
    if (!NEST_EXCEPTION_RE.test(line)) continue;
    if (/^\s*\*/.test(line)) continue; // a doc comment showing the old shape
    const exempt = lines
      .slice(Math.max(0, index - 4), index)
      .some((previous) => previous.includes('i18n-exempt:'));
    if (exempt) continue;
    fail(
      `${file}:${index + 1}: raises an HTTP failure directly. Use ` +
        '`userError.<kind>(code, english, params)` when a person reads it, or ' +
        '`untranslatedError.<kind>(message)` when it is a developer error, a machine ' +
        'client, or text we did not write. See project/src/infrastructure/api-error.ts.',
    );
  }
}

// ── 8b: hardcoded literals in the SPA (heuristic, honestly scoped) ───────────

/**
 * WHAT THIS CATCHES: English JSX text of two words or more between tags, and
 * English strings of two words or more assigned to the attributes that render
 * text (`placeholder`, `title`, `aria-label`, `aria-description`, `alt`,
 * `label`), in project/web/src, outside specs. The threshold was three words
 * until F14; two catches "Save changes" and "No results yet", which three
 * missed, and it produced no false positive on the current tree.
 *
 * WHAT THIS DOES NOT CATCH, stated plainly rather than papered over:
 *
 *  - single words ("Save", "Cancel"): indistinguishable from identifiers,
 *    class names, enum values and CSS tokens at this level of analysis;
 *  - text built at runtime from variables, including a template literal;
 *  - strings passed as ordinary function arguments or object values, which is
 *    where a reintroduced literal is most likely to hide today;
 *  - text inside a `<Trans>` child element;
 *  - the server's non-HTTP output: log lines, prompt assembly, the receipt and
 *    report payloads, and the CLI. Those are not copy, and treating them as
 *    copy would bury the real findings.
 *
 * The server side (8a) is exact; this one is a regression net for the common
 * shape of a reintroduced literal, not a proof of coverage. Key sync (check 1),
 * the completeness count (check 6) and the code parity (check 7) are the checks
 * that carry weight; this one raises the floor.
 */
const TEXT_ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'aria-description', 'alt', 'label'];
const jsxTextRe = />\s*([A-Z][A-Za-z'’,.!?:;-]*(?:\s+[A-Za-z'’,.!?:;-]+){1,})\s*</g;
const attrRe = new RegExp(
  `\\b(${TEXT_ATTRIBUTES.join('|')})=["']([A-Za-z][^"']*\\s+[^"']*)["']`,
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

// The allowlist stays small because a dead entry is a build error. An entry
// that no longer excuses anything is either a key that has since been
// translated, or a typo that was silently doing nothing.
for (const [tag, namespaces] of Object.entries(IDENTICAL)) {
  if (tag === '//' || tag === 'perLocale') continue;
  for (const [namespace, keys] of Object.entries(namespaces)) {
    for (const key of keys) {
      if (!identicalUsed.has(`${tag}/${namespace}/${key}`)) {
        fail(
          `scripts/ci/i18n-identical.json: "${tag}.${namespace}.${key}" excuses nothing. ` +
            'Every locale has translated it, or it does not exist. Remove the entry.',
        );
      }
    }
  }
}
for (const [locale, tags] of Object.entries(IDENTICAL.perLocale ?? {})) {
  for (const [tag, namespaces] of Object.entries(tags)) {
    for (const [namespace, keys] of Object.entries(namespaces)) {
      for (const key of keys) {
        if (!identicalUsed.has(`${locale}/${tag}/${namespace}/${key}`)) {
          fail(
            `scripts/ci/i18n-identical.json: "perLocale.${locale}.${tag}.${namespace}.${key}" ` +
              'excuses nothing. Remove the entry.',
          );
        }
      }
    }
  }
}

// A locale Cogeto ships as supported is translated, or it is not supported.
// Reported last and in full: the count is the number that matters, and the
// first twenty keys are enough to start on.
for (const [locale, keys] of [...untranslated].sort()) {
  fail(
    `${locale}: ${keys.length} value(s) are still their English source, so this locale is ` +
      'not translated.\n' +
      keys
        .slice(0, 20)
        .map((key) => `        ${key}`)
        .join('\n') +
      (keys.length > 20 ? `\n        … and ${keys.length - 20} more` : '') +
      '\n      Translate them, or add a term that is identical BY DESIGN to ' +
      'scripts/ci/i18n-identical.json.',
  );
}

if (problems.length > 0) {
  console.error(`check-i18n: ${problems.length} problem(s).\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('\nSee docs/features/i18n.md for the rules and the translator workflow.');
  process.exit(1);
}

// The coverage line is printed on SUCCESS, deliberately: the number is what a
// reader of the build log can compare against last week's, and a locale that
// starts sliding back toward scaffold state shows up here before it shows up
// on a screen.
const coverage = [...localeTotals]
  .sort()
  .map(([locale, total]) => `${locale} ${total - (untranslated.get(locale)?.length ?? 0)}/${total}`)
  .join(' · ');
console.log(
  `check-i18n: ${localeTotals.size} locales in sync and fully translated (${coverage} values ` +
    `translated, ${identicalUsed.size} identical by design).`,
);
