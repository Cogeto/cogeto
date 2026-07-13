#!/usr/bin/env node
// verify:version — the git tag and package.json are the two sources of truth for
// a release, and they must agree. On a tag build this asserts that the pushed
// tag `vX.Y.Z` equals the `version` in package.json; a mismatch fails the build
// before anything is published. There is deliberately no VERSION file.
//
// Tag resolution (first hit wins):
//   1. argv[2]                      — explicit tag, e.g. `node verify-version.mjs v1.2.3`
//   2. $GITHUB_REF_NAME             — set by GitHub Actions on a tag push
//   3. `git describe --tags --exact-match HEAD` — local tag on the checked-out commit
//
// If no tag can be resolved this is not a tag build: it prints the package
// version and exits 0 (so `npm run verify:version` is safe to run any time).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const pkgVersion = pkg.version;

function resolveTag() {
  const explicit = process.argv[2];
  if (explicit) return explicit.trim();
  if (process.env.GITHUB_REF_NAME && process.env.GITHUB_REF_TYPE === 'tag') {
    return process.env.GITHUB_REF_NAME.trim();
  }
  if (process.env.GITHUB_REF_NAME && !process.env.GITHUB_REF_TYPE) {
    return process.env.GITHUB_REF_NAME.trim();
  }
  try {
    return execFileSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

const tag = resolveTag();

if (!tag) {
  console.log(
    `verify:version — no tag on HEAD; package.json version is ${pkgVersion}. ` +
      `(A release is cut by tagging v${pkgVersion}.)`,
  );
  process.exit(0);
}

const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(tag);
if (!match) {
  console.error(
    `verify:version FAILED — tag "${tag}" is not a valid release tag. ` +
      `Expected the form vX.Y.Z (semver), e.g. v${pkgVersion}.`,
  );
  process.exit(1);
}

const tagVersion = match[1];
if (tagVersion !== pkgVersion) {
  console.error(
    `verify:version FAILED — git tag ${tag} (=> ${tagVersion}) does not match ` +
      `package.json version ${pkgVersion}.\n` +
      `Bump "version" in package.json to ${tagVersion} (or retag), then re-run. ` +
      `The tag and package.json must be identical to release.`,
  );
  process.exit(1);
}

console.log(`verify:version OK — tag ${tag} matches package.json version ${pkgVersion}.`);
