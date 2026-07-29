#!/usr/bin/env node
/**
 * Documentation copy guard: no em or en dashes in the markdown a reader sees.
 *
 * The house style is that Cogeto's own copy carries no typographic dashes;
 * a sentence gets a comma, a colon, a period, or a rewrite instead, never a
 * mechanical hyphen. ESLint enforces this for product strings
 * (`copy/no-typographic-dashes`); this script does the same for markdown,
 * which ESLint cannot see.
 *
 * Exempt, deliberately:
 *   - project/prompts/**  released prompt artifacts are immutable once shipped
 *   - project/eval/**     golden-set corpus data, authored to look like real input
 *   - docs/eval/history.md  an append-only measurement record
 *   - LICENSE and third-party text
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const EXEMPT = [/^project\/prompts\//, /^project\/eval\//, /^docs\/eval\/history\.md$/, /^LICENSE/];

const files = execFileSync('git', ['ls-files', '*.md'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((f) => !EXEMPT.some((rx) => rx.test(f)));

const offences = [];
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return;
    const match = line.match(/[—–]/);
    if (match) {
      const kind = match[0] === '—' ? 'em dash' : 'en dash';
      offences.push(`${file}:${i + 1}  ${kind}  ${line.trim().slice(0, 100)}`);
    }
  });
}

if (offences.length > 0) {
  console.error(
    `Typographic dashes in documentation copy (${offences.length}).\n` +
      'Rewrite the sentence with a comma, a colon, a period, or a restructure. ' +
      'Never substitute a hyphen.\n',
  );
  for (const offence of offences) console.error(`  ${offence}`);
  process.exit(1);
}

console.log(`doc copy guard: ${files.length} markdown files clean.`);
