import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * The read side of the demo sandbox's login credentials.
 *
 * The sandbox is password-gated, not auto-open: instead of publishing Ana's
 * bearer token on the public `/api/config`, the operator signs in with a
 * username and a generated password. Verifying that attempt is an identity
 * concern, so the file contract and its reader live here with
 * `POST /api/config/demo-login` (V2.0 item 3.6 part 2).
 *
 * The WRITE side — generating the password, persisting both files, printing the
 * operator banner — stays with the demo bootstrap in `entrypoints/demo/`, which
 * is a CLI and may import this module. The reverse would not be allowed, and
 * that direction is the whole reason this file exists.
 *
 * A leaf by design: node built-ins only.
 */

/** The fixed sandbox login name. The password rotates; this does not. */
export const DEMO_USERNAME = 'ana@cogeto.localhost';

export interface DemoCredentials {
  username: string;
  password: string;
}

/** The machine-readable credentials file, beside the demo session file. */
export function demoLoginFile(demoSessionFile: string): string {
  return join(dirname(demoSessionFile), 'demo-login.json');
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
