#!/usr/bin/env node
/**
 * Documentation link guard: every relative markdown link resolves to a file
 * that exists.
 *
 * The doc map in CLAUDE.md, the runbook and the audits are navigation, not
 * decoration: a link that 404s sends an operator looking for a procedure that,
 * as far as they can tell, does not exist. The deployment-readiness audit had
 * to find the one broken link in this repository by hand, which is the sign
 * that nothing was watching. Now something is.
 *
 * Scope and deliberate limits:
 *   - relative links only. External URLs are not fetched: a network call in
 *     `lint` would make the build depend on someone else's uptime.
 *   - anchors (`#section`) are stripped, not verified. Heading anchors drift
 *     with wording and a false failure teaches people to skip the check.
 *   - generated and vendored trees are skipped (node_modules, dist, .git, the
 *     eval cache).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.git', 'dist', 'cache', 'coverage']);
/** `[text](target)`, with an optional `"title"` after the target. */
const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function markdownFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(full, acc);
    else if (entry.name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

const broken = [];
let checked = 0;
const files = markdownFiles(ROOT);

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(LINK)) {
    const raw = match[1];
    if (/^(https?:|mailto:|tel:|#)/.test(raw)) continue;
    const target = raw.split('#')[0];
    if (!target) continue;
    checked += 1;
    const resolved = target.startsWith('/')
      ? path.join(ROOT, target)
      : path.resolve(path.dirname(file), decodeURI(target));
    if (!existsSync(resolved)) {
      broken.push(`${path.relative(ROOT, file)}: ${raw}`);
    }
  }
}

if (broken.length > 0) {
  console.error(`Broken relative documentation links (${broken.length}):\n`);
  for (const line of broken) console.error(`  ${line}`);
  console.error('\nFix the path, or point at the file that replaced it.');
  process.exit(1);
}

console.log(
  `doc links: ${checked} relative links across ${files.length} markdown files, all resolve`,
);
