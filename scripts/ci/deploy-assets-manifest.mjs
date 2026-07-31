#!/usr/bin/env node
/**
 * Deployment-asset checksum manifest (security audit 2.0 SEC-13).
 *
 * The operator installer fetches the files that define the entire customer
 * stack — the compose file, the production Caddyfile, the Zitadel bootstrap
 * script, the Postgres role provisioning, the SearXNG settings — from
 * raw.githubusercontent.com. It used to do so at a TAG ref, and git tags are
 * mutable unless the repository protects them, so the stack definition could
 * change under a fixed version.
 *
 * The installer now pins the fetch to the immutable commit the tag points at
 * and verifies every file against this manifest, fetched at the same commit.
 * That makes one commit id the anchor for the whole set.
 *
 * The manifest is generated from the working tree and must be regenerated
 * whenever one of the assets changes:
 *
 *   node scripts/ci/deploy-assets-manifest.mjs --write
 *
 * `--check` (the default, and what CI runs via the operator-script spec)
 * recomputes and exits non-zero on any drift.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every file the installer fetches, in the order it fetches them. */
export const DEPLOY_ASSETS = [
  'project/infra/deploy/docker-compose.deploy.yml',
  'project/infra/deploy/Caddyfile',
  'project/infra/docker/zitadel-init/init.mjs',
  'project/infra/docker/postgres-init/db-init.sql',
  'project/infra/docker/searxng/settings.yml',
];

export const MANIFEST_PATH = 'project/infra/deploy/deploy-assets.sha256';

/** The manifest content the working tree implies: `<sha256>  <repo path>`. */
export async function buildManifest(repoRoot = REPO) {
  const lines = [];
  for (const asset of DEPLOY_ASSETS) {
    const bytes = await readFile(path.join(repoRoot, asset));
    lines.push(`${createHash('sha256').update(bytes).digest('hex')}  ${asset}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const write = process.argv.includes('--write');
  const expected = await buildManifest();
  const target = path.join(REPO, MANIFEST_PATH);
  if (write) {
    await writeFile(target, expected, 'utf8');
    console.log(`wrote ${MANIFEST_PATH} (${DEPLOY_ASSETS.length} assets)`);
    return;
  }
  const actual = await readFile(target, 'utf8').catch(() => '');
  if (actual !== expected) {
    console.error(
      `${MANIFEST_PATH} is out of date with the deployment assets it covers.\n` +
        'Regenerate it: node scripts/ci/deploy-assets-manifest.mjs --write',
    );
    process.exit(1);
  }
  console.log(`${MANIFEST_PATH} matches all ${DEPLOY_ASSETS.length} deployment assets`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
