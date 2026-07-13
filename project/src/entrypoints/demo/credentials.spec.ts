import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEMO_USERNAME,
  demoCredentialsTextFile,
  ensureDemoCredentials,
  generatePassword,
  readDemoLogin,
} from './credentials';

describe('demo credentials (decision 0027)', () => {
  const sessionFileIn = (): string =>
    path.join(mkdtempSync(path.join(tmpdir(), 'cogeto-creds-')), 'session.json');

  it('generates strong, url-safe, distinct passwords', () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(24);
  });

  it('creates credentials and both files, and readDemoLogin round-trips them', async () => {
    const sf = sessionFileIn();
    const creds = await ensureDemoCredentials(sf, { rotate: false });
    expect(creds.username).toBe(DEMO_USERNAME);
    expect(creds.password.length).toBeGreaterThanOrEqual(24);

    expect(await readDemoLogin(sf)).toEqual(creds);
    // The human-readable file carries the password for the operator to read.
    expect(readFileSync(demoCredentialsTextFile(sf), 'utf8')).toContain(creds.password);
  });

  it('REUSES the password across restarts (rotate:false)', async () => {
    const sf = sessionFileIn();
    const first = await ensureDemoCredentials(sf, { rotate: false });
    const second = await ensureDemoCredentials(sf, { rotate: false });
    expect(second.password).toBe(first.password);
  });

  it('ROTATES the password on a reset (rotate:true)', async () => {
    const sf = sessionFileIn();
    const first = await ensureDemoCredentials(sf, { rotate: false });
    const rotated = await ensureDemoCredentials(sf, { rotate: true });
    expect(rotated.password).not.toBe(first.password);
    // And the rotated one is what's now persisted.
    expect((await readDemoLogin(sf))?.password).toBe(rotated.password);
  });

  it('readDemoLogin returns null when nothing is persisted', async () => {
    expect(await readDemoLogin(sessionFileIn())).toBeNull();
  });
});
