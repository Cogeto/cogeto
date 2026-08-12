#!/usr/bin/env node
/**
 * sync-locales.mjs — backfill every locale from `en` (V2.0 item 3.5).
 *
 *     npm run i18n:sync                  # fill holes, prune orphans
 *     npm run i18n:sync -- --dry         # show what would change, touch nothing
 *     npm run i18n:sync -- --refresh     # take the new English into UNREGISTERED values
 *     npm run i18n:sync -- --register    # record today's divergences as translations
 *
 * `npm run i18n:check` DETECTS locale drift and fails the build. This FIXES it,
 * so adding a string to a feature is one command instead of hand-editing the
 * same key into three files. The loop is: add the key to `en`, run this, commit.
 *
 * What it does, per locale root, per namespace, for every locale but `en`:
 *
 *  1. Adds every key `en` has and the locale lacks, with the ENGLISH TEXT as the
 *     value. That is the correct placeholder, not a shortcut: the runtime falls
 *     back to English anyway, so an untranslated locale renders readable copy,
 *     and a translator receives a complete file with the source text in place.
 *  2. Expands plural forms to the ones each language actually needs. English
 *     `_one`/`_other` becomes `_one`/`_few`/`_other` in Croatian and
 *     `_one`/`_many`/`_other` in French, seeded from English `_other`. This is
 *     the part nobody gets right by hand every time.
 *  3. Removes orphans: keys and plural categories the locale carries and `en`
 *     does not. Deliberate, and the reason `--dry` exists: a removal is a
 *     translation being deleted, so look before you run it.
 *  4. Creates a namespace file that is missing entirely.
 *
 * What it deliberately does NOT do:
 *
 *  - **It never overwrites an existing value.** A translated string is left
 *    alone, always. That is what separates this from `i18n:add --force`, which
 *    resets a whole locale to English and would destroy the Croatian server
 *    catalogue. `--refresh` is the one narrow exception, and it touches only
 *    values that are NOT registered as translations (see below).
 *
 * The two flags exist because that promise had a blind side (V2.5 item 8.3
 * follow-up): rewording an English string leaves every other locale holding
 * the PREVIOUS wording, and no check saw it, because key sets still matched.
 *
 *  - `--register` records, per locale, the English each diverging value was
 *    made from, in `<root>/.translations.json`. That is what makes a
 *    translation distinguishable from a stale placeholder at all.
 *  - `--refresh` takes the current English into every UNREGISTERED value,
 *    which by the invariant above is a placeholder holding old English.
 *
 * `npm run i18n:check` fails until one of the two has been used, so the drift
 * cannot ride along in a green build the way it did once.
 *  - **It never translates.** Machine translation landing in product copy with
 *    nobody reviewing it is a person's decision, not a build script's.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  SOURCE_LOCALE,
  baseKey,
  englishFor,
  existingRoots,
  flatten,
  localesIn,
  namespacesIn,
  nest,
  pluralCategoriesFor,
  pluralCategory,
  readNamespace,
  readTranslations,
  registeredSource,
  translationsPath,
} from '../ci/i18n-keys.mjs';

const flags = process.argv.slice(2);
const dry = flags.includes('--dry');
const refresh = flags.includes('--refresh');
const register = flags.includes('--register');

let added = 0;
let removed = 0;
let touched = 0;
let refreshed = 0;
let registered = 0;

for (const root of existingRoots()) {
  const namespaces = namespacesIn(root, SOURCE_LOCALE);
  const book = readTranslations(root);
  let bookChanged = false;
  for (const locale of localesIn(root)) {
    if (locale === SOURCE_LOCALE) continue;
    const categories = pluralCategoriesFor(locale);

    for (const namespace of namespaces) {
      const source = flatten(readNamespace(root, SOURCE_LOCALE, namespace));
      const path = join(root, locale, `${namespace}.json`);
      const target = existsSync(path) ? flatten(readNamespace(root, locale, namespace)) : new Map();

      // The key set the locale SHOULD have: every non-plural key as-is, and for
      // every plural base, exactly this language's categories.
      const wanted = [];
      const seenPluralBase = new Set();
      for (const [key, value] of source) {
        const category = pluralCategory(key);
        if (category === null) {
          wanted.push([key, value]);
          continue;
        }
        const base = baseKey(key);
        if (seenPluralBase.has(base)) continue;
        seenPluralBase.add(base);
        // Seed each category from English's OWN category when it has one, and
        // fall back to `_other` only for categories English lacks (Croatian
        // `_few`, French `_many`). Seeding everything from `_other` put the
        // plural wording into `_one` in every locale, which the source-drift
        // check surfaced the first time a plural key was added after it landed.
        const fallback = source.get(`${base}_other`) ?? value;
        for (const wantedCategory of categories) {
          wanted.push([
            `${base}_${wantedCategory}`,
            source.get(`${base}_${wantedCategory}`) ?? fallback,
          ]);
        }
      }

      const out = [];
      const localAdds = [];
      const localRefreshed = [];
      const localRegistered = [];
      for (const [key, english] of wanted) {
        // Keep the locale's own value whenever it has one: a translation is
        // never overwritten, only a hole is filled.
        if (!target.has(key)) {
          out.push([key, english]);
          localAdds.push(key);
          continue;
        }
        const value = target.get(key);
        const source = englishFor(flatten(readNamespace(root, SOURCE_LOCALE, namespace)), key);
        const known = registeredSource(book, locale, namespace, key);
        const diverges =
          typeof value === 'string' && typeof source === 'string' && value !== source;

        if (register && diverges) {
          // A value that differs from English is a translation, and this
          // records the English it was made from, so a later reword is
          // reported as an outdated translation rather than passing silently.
          ((book[locale] ??= {})[namespace] ??= {})[key] = source;
          bookChanged = true;
          localRegistered.push(key);
          out.push([key, value]);
          continue;
        }
        if (refresh && diverges && known === undefined) {
          // Unregistered and diverging is, by the invariant, a placeholder
          // holding the PREVIOUS English. Taking the new wording is a repair.
          out.push([key, source]);
          localRefreshed.push(key);
          continue;
        }
        out.push([key, value]);
      }
      const wantedKeys = new Set(wanted.map(([k]) => k));
      const orphans = [...target.keys()].filter((k) => !wantedKeys.has(k));

      const changed =
        localAdds.length + orphans.length + localRefreshed.length + localRegistered.length;
      if (changed === 0 && existsSync(path)) continue;

      touched += 1;
      added += localAdds.length;
      removed += orphans.length;
      refreshed += localRefreshed.length;
      registered += localRegistered.length;
      const label = `${dry ? 'would update' : 'update'} ${path}`;
      console.log(
        `${label}  +${localAdds.length} -${orphans.length}` +
          `${localRefreshed.length ? ` ~${localRefreshed.length}` : ''}` +
          `${localRegistered.length ? ` R${localRegistered.length}` : ''}`,
      );
      for (const key of localAdds) console.log(`    + ${key}`);
      for (const key of orphans) console.log(`    - ${key}  (orphan, not in ${SOURCE_LOCALE})`);
      for (const key of localRefreshed) console.log(`    ~ ${key}  (took the current English)`);

      if (!dry) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(nest(out), null, 2)}\n`, 'utf8');
      }
    }
  }
  if (bookChanged && !dry) {
    writeFileSync(translationsPath(root), `${JSON.stringify(sortDeep(book), null, 2)}\n`, 'utf8');
    console.log(`update ${translationsPath(root)}`);
  }
}

/** Stable key order, so the register diffs like a text file. */
function sortDeep(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sortDeep(value[k])]),
  );
}

if (touched === 0) {
  console.log('i18n:sync: every locale already matches en. Nothing to do.');
} else {
  console.log(
    `\ni18n:sync: ${dry ? 'would touch' : 'touched'} ${touched} file(s), ` +
      `${added} key(s) added, ${removed} orphan(s) removed` +
      `${refreshed ? `, ${refreshed} value(s) refreshed to the current English` : ''}` +
      `${registered ? `, ${registered} translation(s) registered` : ''}.`,
  );
  if (!dry) {
    console.log('Run `npm run i18n:check` to confirm, then commit the locale files.');
    console.log('Added keys carry the ENGLISH text: they are placeholders awaiting translation.');
  }
}
