#!/usr/bin/env node
/**
 * add-locale.mjs — scaffold a new interface locale by copying `en`
 * (V2.0 item 3.5, Issue D point 3).
 *
 *     npm run i18n:add -- <locale>          # e.g. npm run i18n:add -- es
 *     npm run i18n:add -- <locale> --force  # overwrite an existing scaffold
 *
 * What it does, per locale root (the SPA and the server catalogue):
 *
 *  1. Copies every namespace file from `en`, keeping the SAME keys.
 *  2. Keeps the ENGLISH TEXT as each value. That is the point: an untranslated
 *     locale renders correctly, and the translator sees the source text in
 *     place and overwrites it.
 *  3. Expands plural forms to the ones the NEW language needs. English has
 *     `_one`/`_other`; Croatian also needs `_few`, French also needs `_many`.
 *     The extra forms are seeded with the English `_other` text.
 *
 * Adding the locale to the product still needs one more edit, which the script
 * prints: `SUPPORTED_LANGUAGES` and `LANGUAGE_ENDONYMS` in
 * project/shared/src/user-context.ts.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  SOURCE_LOCALE,
  existingRoots,
  flatten,
  namespacesIn,
  nest,
  pluralCategoriesFor,
  pluralCategory,
  readNamespace,
} from '../ci/i18n-keys.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const locale = args.find((a) => !a.startsWith('--'));

if (!locale || !/^[a-z]{2}(-[A-Za-z0-9]+)?$/.test(locale)) {
  console.error('usage: node scripts/dev/add-locale.mjs <locale> [--force]');
  console.error('       <locale> is a BCP-47 language code, e.g. es or pt-BR');
  process.exit(2);
}
if (locale === SOURCE_LOCALE) {
  console.error(`add-locale: ${SOURCE_LOCALE} is the source locale and already exists.`);
  process.exit(2);
}

let targetCategories;
try {
  targetCategories = pluralCategoriesFor(locale);
} catch {
  console.error(`add-locale: "${locale}" is not a language tag this runtime knows.`);
  process.exit(2);
}

let written = 0;
for (const root of existingRoots()) {
  const dir = join(root, locale);
  mkdirSync(dir, { recursive: true });
  for (const namespace of namespacesIn(root, SOURCE_LOCALE)) {
    const path = join(dir, `${namespace}.json`);
    if (existsSync(path) && !force) {
      console.log(`  skip  ${path} (exists; pass --force to overwrite)`);
      continue;
    }
    const source = flatten(readNamespace(root, SOURCE_LOCALE, namespace));
    const out = [];
    const seenPluralBase = new Set();
    for (const [key, value] of source) {
      const category = pluralCategory(key);
      if (category === null) {
        out.push([key, value]);
        continue;
      }
      // A plural key: emit exactly the forms the TARGET language needs, once
      // per base key, seeded from English `_other` (its most general form).
      const base = key.slice(0, -`_${category}`.length);
      if (seenPluralBase.has(base)) continue;
      seenPluralBase.add(base);
      const seed = source.get(`${base}_other`) ?? value;
      for (const target of targetCategories) {
        out.push([`${base}_${target}`, source.get(`${base}_${target}`) ?? seed]);
      }
    }
    writeFileSync(path, `${JSON.stringify(nest(out), null, 2)}\n`, 'utf8');
    written += 1;
    console.log(`  write ${path}`);
  }
}

console.log(`\nadd-locale: wrote ${written} file(s) for "${locale}".`);
console.log(`Plural forms for "${locale}": ${targetCategories.join(', ')}.`);
console.log('\nStill to do:');
console.log(`  1. Add "${locale}" to SUPPORTED_LANGUAGES and LANGUAGE_ENDONYMS`);
console.log('     (and LOCALE_TAGS) in project/shared/src/user-context.ts.');
console.log('  2. Translate the values. See docs/features/i18n.md, "For the translator".');
console.log('  3. Run `npm run i18n:check` and switch a user to the new language.');
