import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebConfigController } from './web-config.controller';
import type { CogetoConfig } from './config';

/**
 * FIX-2 QS-3: serving the demo session is FAIL-CLOSED — it requires an explicit
 * COGETO_DEMO_MODE=1. A stray session file never flips the SPA into sandbox mode.
 */
describe('web-config demo fail-closed (QS-3)', () => {
  let dir: string;
  let webConfigFile: string;
  let sessionFile: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cogeto-webcfg-'));
    webConfigFile = path.join(dir, 'config.json');
    sessionFile = path.join(dir, 'session.json');
    writeFileSync(webConfigFile, JSON.stringify({ issuer: 'https://localhost', clientId: 'abc' }));
    // A demo session file is PRESENT the whole time — it must not, by itself,
    // ever cause a token to be served.
    writeFileSync(sessionFile, JSON.stringify({ accessToken: 'demo-token-value' }));
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

  it('serves NO demo session when demo mode is off, even though the session file exists', async () => {
    const result = await controller(configWith({ demoMode: false })).webConfig();
    expect(result.clientId).toBe('abc');
    expect(result.demoMode).toBeUndefined();
    expect('demoSession' in result).toBe(false);
  });

  it('serves the demo session ONLY with explicit demo mode', async () => {
    const result = await controller(configWith({ demoMode: true })).webConfig();
    expect(result.demoMode).toBe(true);
    expect(result.demoSession?.accessToken).toBe('demo-token-value');
  });

  it('never serves a demo session on a production instance, even with demo mode set', async () => {
    const result = await controller(configWith({ demoMode: true, production: true })).webConfig();
    expect(result.demoMode).toBeUndefined();
    expect('demoSession' in result).toBe(false);
  });
});
