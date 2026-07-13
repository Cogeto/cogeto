import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Demo login credentials (decision 0027, revising 0022 ruling 1). The sandbox is
 * no longer auto-open: instead of the app publishing Ana's bearer token on the
 * public /api/config, the operator logs in with a username + a GENERATED
 * password that only they (via the seed/reset logs or the credentials file) can
 * see. This module owns generating, persisting, and surfacing that password.
 *
 * Two files live next to the demo session file (same demo-config volume):
 *  - `demo-login.json`  — machine-readable { username, password }, read by the
 *    app to verify a POST /api/config/demo-login attempt. World-readable (0644)
 *    like the session file, because the app runs as a different uid.
 *  - `demo-credentials.txt` — human-readable, for the operator to `cat`.
 *
 * A leaf by design: it imports only node built-ins, so the app's web-config
 * controller can reuse the path/read helpers without pulling in the rest of the
 * demo bootstrap (zitadel-admin, http-client, …).
 */

/** The fixed sandbox login name (decision 0027). The password rotates; this does not. */
export const DEMO_USERNAME = 'ana@cogeto.localhost';

export interface DemoCredentials {
  username: string;
  password: string;
}

/** The machine-readable credentials file the app reads to verify a login. */
export function demoLoginFile(demoSessionFile: string): string {
  return join(dirname(demoSessionFile), 'demo-login.json');
}

/** The human-readable credentials file the operator reads. */
export function demoCredentialsTextFile(demoSessionFile: string): string {
  return join(dirname(demoSessionFile), 'demo-credentials.txt');
}

/** A strong, URL-safe random password — long enough that online guessing is infeasible. */
export function generatePassword(): string {
  return randomBytes(24).toString('base64url');
}

/** Reads the persisted { username, password }, or null if absent/malformed. */
export async function readDemoLogin(demoSessionFile: string): Promise<DemoCredentials | null> {
  try {
    const parsed = JSON.parse(await readFile(demoLoginFile(demoSessionFile), 'utf8')) as {
      username?: unknown;
      password?: unknown;
    };
    if (
      typeof parsed.username === 'string' &&
      typeof parsed.password === 'string' &&
      parsed.password
    ) {
      return { username: parsed.username, password: parsed.password };
    }
    return null;
  } catch {
    return null;
  }
}

async function writeWorldReadable(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true }).catch(() => undefined);
  // 0644 ON PURPOSE (mirrors the session file, decision 0022): the seed job runs
  // as root but the app process (uid `node`) must read demo-login.json.
  await writeFile(file, content, { mode: 0o644 });
  await chmod(file, 0o644).catch(() => undefined);
}

/**
 * Ensures a demo password exists and returns it. With `rotate: false` (seed /
 * restart) an existing password is REUSED so the operator's known password stays
 * valid across container restarts; with `rotate: true` (a reset) a fresh one is
 * generated. Writes both the machine- and human-readable files.
 */
export async function ensureDemoCredentials(
  demoSessionFile: string,
  opts: { rotate: boolean },
): Promise<DemoCredentials> {
  const existing = opts.rotate ? null : await readDemoLogin(demoSessionFile);
  const credentials: DemoCredentials = existing ?? {
    username: DEMO_USERNAME,
    password: generatePassword(),
  };
  await writeWorldReadable(demoLoginFile(demoSessionFile), JSON.stringify(credentials, null, 2));
  await writeWorldReadable(demoCredentialsTextFile(demoSessionFile), credentialsText(credentials));
  return credentials;
}

function credentialsText(c: DemoCredentials): string {
  return [
    'Cogeto demo sandbox login (decision 0027)',
    `  username: ${c.username}`,
    `  password: ${c.password}`,
    '',
    'Open the app and sign in with the above. The password rotates on every',
    '`demo:reset` (and the scheduled reset); re-read this file after a reset.',
    '',
  ].join('\n');
}

/** A loud, multi-line banner for the seed/reset job logs (never logs the token). */
export function credentialsBanner(c: DemoCredentials): string {
  const bar = '═'.repeat(58);
  return [
    '',
    bar,
    '  DEMO SANDBOX LOGIN — sign in at the app with these:',
    `    username: ${c.username}`,
    `    password: ${c.password}`,
    '  (also written to demo-credentials.txt on the demo-config volume)',
    bar,
    '',
  ].join('\n');
}
