import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * env_consistency (O1-C, closes gap-audit 2.10/5.3): every COGETO_* env var the
 * app reads is documented where an operator can find it (.env.example or
 * docker-compose.yml), and every COGETO_* in .env.example is actually used
 * (read by code or wired in compose). No container needed — pure file reads.
 */

// Vitest runs from project/src; the repo root is two levels up.
const SRC = process.cwd();
const REPO = path.resolve(SRC, '../..');

/** Dev/CI-only toggles set by npm scripts or seed tooling — not operator config. */
const DEV_ONLY = new Set([
  'COGETO_EVAL_GATE',
  'COGETO_SEED_ORG',
  'COGETO_SEED_OWNER',
  // Test-only: vitest points the demo corpus loader at project/demo (decision 0022).
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

describe('env_consistency: .env.example, docker-compose.yml and code agree', () => {
  const read = varsReadInCode();
  const example = varsIn('.env.example');
  const compose = varsIn('docker-compose.yml');

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
});
