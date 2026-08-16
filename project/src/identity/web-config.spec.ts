import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { InMemoryRateLimitStore } from '../infrastructure/index';
import { WebConfigController } from './web-config.controller';
import type { WebConfigOptions } from './identity-options';

/**
 * Ana sandbox is FAIL-CLOSED and, since, PASSWORD-GATED: the
 * token is never served on GET /api/config; the SPA advertises a login and the
 * operator exchanges username + generated password at POST /api/config/demo-login.
 */
describe('web-config demo password gate', () => {
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

  const configWith = (over: Partial<WebConfigOptions>): WebConfigOptions =>
    ({
      webConfigFile,
      demoSessionFile: sessionFile,
      demoMode: false,
      production: false,
      ...over,
    }) as WebConfigOptions;

  const controller = (config: WebConfigOptions, limiter = new InMemoryRateLimitStore()) =>
    new WebConfigController(config, limiter);

  /** A request as Caddy delivers it: the client's address in X-Forwarded-For. */
  const req = (ip = '198.51.100.7'): Request =>
    ({
      headers: { 'x-forwarded-for': ip },
      socket: { remoteAddress: '172.18.0.5' },
    }) as unknown as Request;

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
    const result = await controller(configWith({ demoMode: true })).demoLogin(
      {
        username: USERNAME,
        password: PASSWORD,
      },
      req(),
    );
    expect(result.accessToken).toBe('demo-token-value');
  });

  it('demo-login rejects a wrong password with 401 (no token leak)', async () => {
    await expect(
      controller(configWith({ demoMode: true })).demoLogin(
        { username: USERNAME, password: 'wrong' },
        req(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('demo-login is refused on a non-demo / production instance', async () => {
    await expect(
      controller(configWith({ demoMode: false })).demoLogin(
        { username: USERNAME, password: PASSWORD },
        req(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      controller(configWith({ demoMode: true, production: true })).demoLogin(
        { username: USERNAME, password: PASSWORD },
        req(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // ── The wall on the one public credential exchange (issue #636) ────────────

  it('demo_login_rate_limited: repeated wrong passwords hit a 429 wall', async () => {
    const only = controller(configWith({ demoMode: true }));
    const attacker = req('203.0.113.99');
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      try {
        await only.demoLogin({ username: USERNAME, password: `guess-${i}` }, attacker);
        statuses.push(200);
      } catch (error) {
        statuses.push(error instanceof HttpException ? error.getStatus() : 0);
      }
    }
    // The first attempts are honest 401s; the window then closes with 429s.
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('demo_login_counts_the_correct_password_too', async () => {
    // The count happens BEFORE the comparison, so a valid credential cannot
    // be used to keep a window open for a guessing run beside it.
    const only = controller(configWith({ demoMode: true }));
    const client = req('203.0.113.100');
    for (let i = 0; i < 10; i += 1) {
      await only.demoLogin({ username: USERNAME, password: PASSWORD }, client);
    }
    await expect(
      only.demoLogin({ username: USERNAME, password: PASSWORD }, client),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('demo_login_walls_are_per_client, so one attacker cannot lock the sandbox out', async () => {
    // Caddy appends the peer it observed to X-Forwarded-For, so the LAST hop
    // is trustworthy and is what the key reads. Keying on the socket instead
    // would put every visitor of a public sandbox in one bucket.
    const only = controller(configWith({ demoMode: true }));
    const attacker = req('203.0.113.101');
    for (let i = 0; i < 11; i += 1) {
      await only.demoLogin({ username: USERNAME, password: 'x' }, attacker).catch(() => undefined);
    }
    await expect(
      only.demoLogin({ username: USERNAME, password: 'x' }, attacker),
    ).rejects.toMatchObject({ status: 429 });

    // A different visitor is unaffected and still gets their session.
    const visitor = await only.demoLogin(
      { username: USERNAME, password: PASSWORD },
      req('198.51.100.42'),
    );
    expect(visitor.accessToken).toBe('demo-token-value');
  });

  it('demo_login_ignores_a_client_supplied_forwarded_for_prefix', async () => {
    // Everything before Caddy's own hop is client-supplied and forgeable; a
    // spoofed prefix must not let one client masquerade as many.
    const only = controller(configWith({ demoMode: true }));
    const spoofing = (n: number): Request =>
      ({
        headers: { 'x-forwarded-for': `10.0.0.${n}, 203.0.113.200` },
        socket: { remoteAddress: '172.18.0.5' },
      }) as unknown as Request;
    for (let i = 0; i < 11; i += 1) {
      await only
        .demoLogin({ username: USERNAME, password: 'x' }, spoofing(i))
        .catch(() => undefined);
    }
    // Every attempt keyed on the real last hop, so the wall still closed.
    await expect(
      only.demoLogin({ username: USERNAME, password: 'x' }, spoofing(99)),
    ).rejects.toMatchObject({ status: 429 });
  });
});
