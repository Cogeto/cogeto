import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { WebConfigController } from './web-config.controller';
import type { CogetoConfig } from './config';

/**
 * Ana sandbox is FAIL-CLOSED (QS-3) and, since decision 0027, PASSWORD-GATED: the
 * token is never served on GET /api/config; the SPA advertises a login and the
 * operator exchanges username + generated password at POST /api/config/demo-login.
 */
describe('web-config demo password gate (QS-3, decision 0027)', () => {
  let dir: string;
  let webConfigFile: string;
  let sessionFile: string;

  const USERNAME = 'ana@cogeto.localhost';
  const PASSWORD = 'a-strong-generated-password';

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cogeto-webcfg-'));
    webConfigFile = path.join(dir, 'config.json');
    sessionFile = path.join(dir, 'session.json');
    writeFileSync(webConfigFile, JSON.stringify({ issuer: 'https://localhost', clientId: 'abc' }));
    // The session token + the login credentials are present the whole time — they
    // must never, by themselves, cause a token to be served on GET.
    writeFileSync(sessionFile, JSON.stringify({ accessToken: 'demo-token-value' }));
    writeFileSync(
      path.join(dir, 'demo-login.json'),
      JSON.stringify({ username: USERNAME, password: PASSWORD }),
    );
  });
  afterAll(() => undefined);

  const configWith = (over: Partial<CogetoConfig>): CogetoConfig =>
    ({
      webConfigFile,
      demoSessionFile: sessionFile,
      demoMode: false,
      production: false,
      ...over,
    }) as CogetoConfig;

  const controller = (config: CogetoConfig) => new WebConfigController(config);

  it('serves NO token or demo flags when demo mode is off, even with the files present', async () => {
    const result = await controller(configWith({ demoMode: false })).webConfig();
    expect(result.clientId).toBe('abc');
    expect(result.demoMode).toBeUndefined();
    expect(result.demoLogin).toBeUndefined();
    expect('demoSession' in result).toBe(false);
  });

  it('advertises the password-gated login with demo mode — but NEVER a token', async () => {
    const result = await controller(configWith({ demoMode: true })).webConfig();
    expect(result.demoMode).toBe(true);
    expect(result.demoLogin).toBe(true);
    // The auto-login token path is gone entirely.
    expect('demoSession' in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain('demo-token-value');
  });

  it('exposes nothing on a production instance, even with demo mode set', async () => {
    const result = await controller(configWith({ demoMode: true, production: true })).webConfig();
    expect(result.demoMode).toBeUndefined();
    expect(result.demoLogin).toBeUndefined();
  });

  it('demo-login returns the session token for the correct username + password', async () => {
    const result = await controller(configWith({ demoMode: true })).demoLogin({
      username: USERNAME,
      password: PASSWORD,
    });
    expect(result.accessToken).toBe('demo-token-value');
  });

  it('demo-login rejects a wrong password with 401 (no token leak)', async () => {
    await expect(
      controller(configWith({ demoMode: true })).demoLogin({
        username: USERNAME,
        password: 'wrong',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('demo-login is refused on a non-demo / production instance', async () => {
    await expect(
      controller(configWith({ demoMode: false })).demoLogin({
        username: USERNAME,
        password: PASSWORD,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      controller(configWith({ demoMode: true, production: true })).demoLogin({
        username: USERNAME,
        password: PASSWORD,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
