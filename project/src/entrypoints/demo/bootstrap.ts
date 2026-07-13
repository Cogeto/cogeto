import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Principal } from '@cogeto/shared';
import type { CogetoConfig } from '../config';
import { createDemoApi } from './http-client';
import type { DemoApi } from './http-client';
import { ensureDemoCredentials } from './credentials';
import { provisionDemoPrincipal } from './zitadel-admin';

/**
 * Shared demo bootstrap (decision 0022): wait for the app, obtain the demo
 * Principal's session (reusing the persisted token when it still resolves, else
 * provisioning a fresh one), publish it to the shared demo-config file the app
 * serves on /api/config, and return a ready DemoApi + the owner id.
 */

export interface DemoSession {
  api: DemoApi;
  principal: Principal;
  ownerId: string;
  accessToken: string;
  /** The operator's login credentials for the sandbox (decision 0027). */
  loginUsername: string;
  loginPassword: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls the app until it answers liveness (it depends_on migrations already). */
export async function waitForApp(appUrl: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `${appUrl.replace(/\/$/, '')}/api/health/live`;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // keep waiting
    }
    if (Date.now() > deadline)
      throw new Error(`app did not become live within ${timeoutMs}ms (${url})`);
    await sleep(1000);
  }
}

async function readPersistedToken(file: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { accessToken?: unknown };
    return typeof parsed.accessToken === 'string' && parsed.accessToken ? parsed.accessToken : null;
  } catch {
    return null;
  }
}

async function writeSessionFile(file: string, accessToken: string, ownerId: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true }).catch(() => undefined);
  // World-readable ON PURPOSE (decision 0022): the demo-seed job runs as root but
  // the app process runs as uid `node` and must read this to publish the session
  // on /api/config — where the token is already public anyway. `chmod` covers the
  // case where the file already exists (umask would otherwise keep it 0600).
  await writeFile(file, JSON.stringify({ accessToken, ownerId }, null, 2), { mode: 0o644 });
  await chmod(file, 0o644).catch(() => undefined);
}

/** Returns a working demo session, provisioning the Principal if needed. */
export async function establishDemoSession(config: CogetoConfig): Promise<DemoSession> {
  await waitForApp(config.demoAppUrl);

  // Reuse the persisted token when it still resolves (idempotent re-runs / resets
  // keep the same Principal so open tabs survive).
  const persisted = await readPersistedToken(config.demoSessionFile);
  if (persisted) {
    const api = createDemoApi(config.demoAppUrl, persisted);
    try {
      const principal = await api.me();
      // Re-assert file permissions so the app (a different uid) can read it even
      // when reusing a token an earlier run wrote (decision 0022).
      await writeSessionFile(config.demoSessionFile, persisted, principal.userId);
      return withCredentials(config, api, principal, persisted);
    } catch {
      // fall through and provision a fresh token
    }
  }

  const { token } = await provisionDemoPrincipal({
    internalUrl: config.oidc.internalUrl,
    externalDomain: config.oidc.externalDomain,
    patFile: config.zitadelPatFile,
  });
  const api = createDemoApi(config.demoAppUrl, token);
  const principal = await api.me();
  await writeSessionFile(config.demoSessionFile, token, principal.userId);
  return withCredentials(config, api, principal, token);
}

/**
 * Attaches the operator login credentials (decision 0027) to a resolved session.
 * `rotate: false` — an existing password is reused, so a mere restart does not
 * change the operator's known password; the reset paths rotate it explicitly.
 */
async function withCredentials(
  config: CogetoConfig,
  api: DemoApi,
  principal: Principal,
  accessToken: string,
): Promise<DemoSession> {
  const { username, password } = await ensureDemoCredentials(config.demoSessionFile, {
    rotate: false,
  });
  return {
    api,
    principal,
    ownerId: principal.userId,
    accessToken,
    loginUsername: username,
    loginPassword: password,
  };
}
