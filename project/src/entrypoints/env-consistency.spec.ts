import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * env_consistency (closes gap-audit 2.10/5.3): every COGETO_* env var the
 * app reads is documented where an operator can find it (.env.example or
 * docker-compose.yml), and every COGETO_* in.env.example is actually used
 * (read by code or wired in compose). No container needed — pure file reads.
 */

// Vitest runs from project/src; the repo root is two levels up.
const SRC = process.cwd();
const REPO = path.resolve(SRC, '../..');

/** Dev/CI-only toggles set by npm scripts or seed tooling — not operator config. */
const DEV_ONLY = new Set([
  'COGETO_EVAL_GATE',
  // Harness-only: off | record | replay for the cached pull-request eval job
  // (docs/eval-golden-set.md §6). Never read by a running instance.
  'COGETO_EVAL_CACHE',
  'COGETO_SEED_ORG',
  'COGETO_SEED_OWNER',
  // Test-only: vitest points the demo corpus loader at project/demo.
  'COGETO_DEMO_DIR',
]);

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, acc);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) acc.push(full);
  }
  return acc;
}

function varsReadInCode(): Set<string> {
  const found = new Set<string>();
  const re = /(?:process\.)?env\.(COGETO_[A-Z0-9_]+)/g;
  for (const file of walkTs(SRC)) {
    const text = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) found.add(m[1]!);
  }
  return found;
}

function varsIn(file: string): Set<string> {
  const text = readFileSync(path.join(REPO, file), 'utf8');
  const found = new Set<string>();
  const re = /(COGETO_[A-Z0-9_]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) found.add(m[1]!);
  return found;
}

/** Read by the eval CLIs only, never by a running instance; documenting them
 * in .env.example is for the eval workflow, not the stacks. */
const EVAL_ONLY = new Set(['COGETO_MODEL_GRADER', 'COGETO_PROVIDER_GRADER']);

describe('env_consistency: .env.example, docker-compose.yml and code agree', () => {
  const read = varsReadInCode();
  const example = varsIn('.env.example');
  const compose = varsIn('docker-compose.yml');
  const deploy = varsIn('project/infra/deploy/docker-compose.deploy.yml');

  it('every COGETO_* the app reads is documented in .env.example or docker-compose.yml', () => {
    const undocumented = [...read].filter(
      (v) => !DEV_ONLY.has(v) && !example.has(v) && !compose.has(v),
    );
    expect(undocumented, `undocumented env vars read in code: ${undocumented.join(', ')}`).toEqual(
      [],
    );
  });

  it('every COGETO_* in .env.example is used by code or wired in compose (no dead entries)', () => {
    const dead = [...example].filter((v) => !read.has(v) && !compose.has(v));
    expect(dead, `dead .env.example entries: ${dead.join(', ')}`).toEqual([]);
  });

  // The DELIVERY half (issue #516), which the two assertions above cannot
  // see: a variable can be read by code and documented in .env.example while
  // the compose files silently drop it, so setting it in .env does nothing.
  // Every documented, code-read operator variable must be NAMED in the
  // compose file, or the stack is advertising a knob that does not turn.

  it('every documented, code-read COGETO_* is wired in docker-compose.yml', () => {
    const dropped = [...read].filter(
      (v) => example.has(v) && !DEV_ONLY.has(v) && !EVAL_ONLY.has(v) && !compose.has(v),
    );
    expect(dropped, `documented knobs docker-compose.yml drops: ${dropped.join(', ')}`).toEqual([]);
  });

  it('every documented, code-read COGETO_* is wired in the deploy compose (demo profile excepted)', () => {
    const dropped = [...read].filter(
      (v) =>
        example.has(v) &&
        !DEV_ONLY.has(v) &&
        !EVAL_ONLY.has(v) &&
        // A customer stack must not grow a demo switch: the demo profile
        // belongs to the dev stack alone, deliberately.
        !v.startsWith('COGETO_DEMO') &&
        !deploy.has(v),
    );
    expect(dropped, `documented knobs the deploy compose drops: ${dropped.join(', ')}`).toEqual([]);
  });
});
