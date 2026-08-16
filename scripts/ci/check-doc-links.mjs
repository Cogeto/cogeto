#!/usr/bin/env node
/**
 * Documentation link guard: every relative markdown link, AND every inline
 * code path citation, resolves to a file that exists.
 *
 * The doc map in CLAUDE.md, the runbook and the security docs are navigation,
 * not decoration: a link that 404s sends an operator looking for a procedure
 * that, as far as they can tell, does not exist. The deployment-readiness
 * audit had to find the one broken link in this repository by hand, which is
 * the sign that nothing was watching. Now something is.
 *
 * ## The two conventions, and why both are checked (issue #634)
 *
 * The security documentation cites its evidence as INLINE CODE, not as
 * markdown links: "Web fetcher SSRF: `project/src/research/web-fetch.spec.ts`".
 * That convention carries the load in the one place a reviewer is most likely
 * to follow a pointer — the "how to verify it" tables — and it was entirely
 * unchecked, because only `[text](target)` was. The module split moved five
 * specs out of `connectors/` into `email/` and `research/`, and one controller
 * out of `entrypoints/` into `operations/`, and every citation of them rotted
 * silently. A reviewer opening `docs/security/README.md` to check a claim
 * found nothing at each of the paths it named.
 *
 * ## Scope and deliberate limits
 *
 *   - relative markdown links only. External URLs are not fetched: a network
 *     call in `lint` would make the build depend on someone else's uptime.
 *   - anchors (`#section`) are stripped, not verified. Heading anchors drift
 *     with wording and a false failure teaches people to skip the check.
 *   - inline code spans are checked only when they LOOK like a repository
 *     path: they start with a real top-level directory and contain a `/`.
 *     Prose that happens to be in backticks is left alone.
 *   - an inline path resolves against the repository root FIRST and against
 *     the citing file's own directory second, because both conventions are in
 *     use: security docs cite `project/src/...` from the root, while
 *     `docs/README.md` writes `eval/history.md` for its sibling directory.
 *     A path that resolves either way passes.
 *   - placeholder notation (`<locale>`, `{lang}`, brace expansion) is skipped
 *     structurally: those spans are patterns the docs are explaining, never
 *     files anyone can open.
 *   - what it still CANNOT verify, and this is the important limit: that a
 *     cited path is the RIGHT one. A citation pointing at a real file that no
 *     longer contains the thing it claims to prove passes this check
 *     unchanged. It catches a path that rotted; only a reader catches a claim
 *     that did.
 *   - generated and vendored trees are skipped (node_modules, dist, .git, the
 *     eval cache).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.git', 'dist', 'cache', 'coverage']);
/** `[text](target)`, with an optional `"title"` after the target. */
const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
/** A single-backtick code span. */
const CODE = /`([^`\n]+)`/g;

/** Top-level directories a repository-root path citation can start with. */
const ROOTS = ['project/', 'docs/', 'scripts/', 'assets/', 'eval/', '.github/'];

/**
 * Inline code spans that look like paths but are deliberately not files.
 * Each needs a reason: an exemption that excuses nothing is worse than none,
 * because it reads as a considered decision while covering nothing.
 */
const IGNORED = new Map([
  // Illustrative names in authoring instructions, not files that exist.
  ['project/src/google-drive/', 'an example module name in the connector-authoring walkthrough'],
  ['project/src/locales/', 'a path deliberately NOT taken, explained in the i18n doc'],
  // A filename template: one artifact per release, no such literal file.
  ['eval/trust-scores/vX.Y.Z.json', 'a filename template, one per release'],
]);

function markdownFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(full, acc);
    else if (entry.name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

/**
 * True when a code span is a repository path citation worth checking.
 *
 * Placeholder notation is excluded STRUCTURALLY rather than by allowlist:
 * `<locale>`, `{lang}` and brace expansion (`{a,b}.ts`) all mean "one of
 * these", so the span is a pattern the docs are explaining and never a file
 * anyone can open. Listing each one instead would be a list to maintain
 * forever, and every entry on it would excuse a real citation too.
 */
function looksLikePath(span) {
  if (/[ *<>{}]/.test(span)) return false;
  return ROOTS.some((prefix) => span.startsWith(prefix));
}

const brokenLinks = [];
const brokenPaths = [];
const unusedIgnores = new Set(IGNORED.keys());
let links = 0;
let paths = 0;
const files = markdownFiles(ROOT);

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const here = path.relative(ROOT, file);

  for (const match of text.matchAll(LINK)) {
    const raw = match[1];
    if (/^(https?:|mailto:|tel:|#)/.test(raw)) continue;
    const target = raw.split('#')[0];
    if (!target) continue;
    links += 1;
    const resolved = target.startsWith('/')
      ? path.join(ROOT, target)
      : path.resolve(path.dirname(file), decodeURI(target));
    if (!existsSync(resolved)) brokenLinks.push(`${here}: ${raw}`);
  }

  for (const match of text.matchAll(CODE)) {
    const span = match[1].replace(/[.,;:)]+$/, '');
    if (!looksLikePath(span)) continue;
    if (IGNORED.has(span)) {
      unusedIgnores.delete(span);
      continue;
    }
    paths += 1;
    // Repository root first, then relative to the citing file's directory.
    const fromRoot = path.join(ROOT, span);
    const fromHere = path.resolve(path.dirname(file), span);
    if (!existsSync(fromRoot) && !existsSync(fromHere)) {
      brokenPaths.push(`${here}: \`${span}\``);
    }
  }
}

let failed = false;

if (brokenLinks.length > 0) {
  failed = true;
  console.error(`Broken relative documentation links (${brokenLinks.length}):\n`);
  for (const line of brokenLinks) console.error(`  ${line}`);
  console.error('\nFix the path, or point at the file that replaced it.\n');
}

if (brokenPaths.length > 0) {
  failed = true;
  console.error(`Documentation cites paths that do not exist (${brokenPaths.length}):\n`);
  for (const line of brokenPaths) console.error(`  ${line}`);
  console.error(
    '\nA cited path is evidence: the security docs tell a reviewer where to check a claim.\n' +
      'Fix the path (do NOT move code to match a document), or, if it is deliberately not a\n' +
      'file, add it to IGNORED in this script with the reason.\n',
  );
}

if (unusedIgnores.size > 0) {
  failed = true;
  console.error(`IGNORED entries that no longer excuse anything (${unusedIgnores.size}):\n`);
  for (const span of unusedIgnores) console.error(`  \`${span}\` — ${IGNORED.get(span)}`);
  console.error('\nRemove them: an exemption covering nothing reads as a considered decision.\n');
}

if (failed) process.exit(1);

console.log(
  `doc links: ${links} relative links and ${paths} inline path citations across ` +
    `${files.length} markdown files, all resolve`,
);
