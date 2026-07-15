#!/usr/bin/env node
// publish-trust-scores.mjs — thin release-pipeline wrapper around the publish
// logic in project/src/entrypoints/trust-scores.ts (decision 0032). Requires
// the server workspace to be BUILT (the release job runs `npm run build`
// before this). All validation, immutability, and index logic live in the
// imported module so the test suite exercises them without a dist build.
//
//   node scripts/ci/publish-trust-scores.mjs \
//     --version vX.Y.Z --sha <commit> \
//     --partial <file> [--partial <file> ...] \
//     [--out-dir eval/trust-scores] [--note "..." ...]

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const { publishTrustScores } = await import(
  resolve(repoRoot, 'project', 'src', 'dist', 'entrypoints', 'trust-scores.js')
);

const args = process.argv.slice(2);
const take = (flag) => {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) values.push(args[i + 1]);
  }
  return values;
};

const version = take('--version')[0];
const sha = take('--sha')[0];
const partials = take('--partial');
const outDir = take('--out-dir')[0] ?? resolve(repoRoot, 'eval', 'trust-scores');
const notes = take('--note');

if (!version || !sha || partials.length === 0) {
  console.error(
    'usage: publish-trust-scores.mjs --version vX.Y.Z --sha <commit> --partial <file> [...]',
  );
  process.exit(2);
}

try {
  const { file, index } = publishTrustScores({
    outDir,
    version,
    commit: sha,
    partialPaths: partials,
    notes,
  });
  console.log(`trust scores published: ${file}`);
  console.log(`index rebuilt: ${index}`);
} catch (error) {
  console.error(`publish-trust-scores FAILED: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
