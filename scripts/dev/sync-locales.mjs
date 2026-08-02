#!/usr/bin/env node
/**
 * sync-locales.mjs — backfill every locale from `en` (V2.0 item 3.5).
 *
 *     npm run i18n:sync           # fix the files
 *     npm run i18n:sync -- --dry  # show what would change, touch nothing
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
 *    catalogue.
 *  - **It never translates.** Machine translation landing in product copy with
 *    nobody reviewing it is a person's decision, not a build script's.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  SOURCE_LOCALE,
  baseKey,
  existingRoots,
  flatten,
  localesIn,
  namespacesIn,
  nest,
  pluralCategoriesFor,
  pluralCategory,
  readNamespace,
} from '../ci/i18n-keys.mjs';

const dry = process.argv.slice(2).includes('--dry');

let added = 0;
let removed = 0;
let touched = 0;

for (const root of existingRoots()) {
  const namespaces = namespacesIn(root, SOURCE_LOCALE);
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
        const seed = source.get(`${base}_other`) ?? value;
        for (const wantedCategory of categories) {
          wanted.push([`${base}_${wantedCategory}`, seed]);
        }
      }

      const out = [];
      const localAdds = [];
      for (const [key, english] of wanted) {
        // Keep the locale's own value whenever it has one: a translation is
        // never overwritten, only a hole is filled.
        if (target.has(key)) {
          out.push([key, target.get(key)]);
        } else {
          out.push([key, english]);
          localAdds.push(key);
        }
      }
      const wantedKeys = new Set(wanted.map(([k]) => k));
      const orphans = [...target.keys()].filter((k) => !wantedKeys.has(k));

      if (localAdds.length === 0 && orphans.length === 0 && existsSync(path)) continue;

      touched += 1;
      added += localAdds.length;
      removed += orphans.length;
      const label = `${dry ? 'would update' : 'update'} ${path}`;
      console.log(`${label}  +${localAdds.length} -${orphans.length}`);
      for (const key of localAdds) console.log(`    + ${key}`);
      for (const key of orphans) console.log(`    - ${key}  (orphan, not in ${SOURCE_LOCALE})`);

      if (!dry) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(nest(out), null, 2)}\n`, 'utf8');
      }
    }
  }
}

if (touched === 0) {
  console.log('i18n:sync: every locale already matches en. Nothing to do.');
} else {
  console.log(
    `\ni18n:sync: ${dry ? 'would touch' : 'touched'} ${touched} file(s), ` +
      `${added} key(s) added, ${removed} orphan(s) removed.`,
  );
  if (!dry) {
    console.log('Run `npm run i18n:check` to confirm, then commit the locale files.');
    console.log('Added keys carry the ENGLISH text: they are placeholders awaiting translation.');
  }
}
