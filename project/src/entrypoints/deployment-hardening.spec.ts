import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertAppKeyMount, PRIVATE_KEY_FILE, PUBLIC_KEY_FILE } from '../infrastructure/index';

/**
 * FIX-2 deployment hardening — static assertions over the compose stack and
 * Dockerfiles (QS-4, QS-8, QS-9, QS-24, QS-25) plus the app key-mount guard.
 * Pure file reads; no container needed.
 */
const SRC = process.cwd();
const REPO = path.resolve(SRC, '../..');
const read = (rel: string): string => readFileSync(path.join(REPO, rel), 'utf8');

describe('deployment hardening (FIX-2)', () => {
  const compose = read('docker-compose.yml');
  const dockerfile = read('project/infra/docker/Dockerfile');
  const caddyMain = read('project/infra/docker/caddy/Caddyfile');
  const redactionDockerfile = read('project/services/redaction/Dockerfile');

  it('QS-25: every image is pinned by digest (no floating tags)', () => {
    // `image:` lines must reference a digest, never a bare tag.
    const imageLines = compose
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('image:'));
    expect(imageLines.length).toBeGreaterThan(0);
    for (const line of imageLines) {
      expect(line, `unpinned image: ${line}`).toMatch(/@sha256:[0-9a-f]{64}/);
    }
    // The build stages are pinned too.
    expect(dockerfile).not.toMatch(/^FROM node:22-alpine/m);
    expect(dockerfile).toMatch(/FROM node@sha256:[0-9a-f]{64}/);
    expect(dockerfile).toMatch(/FROM caddy@sha256:[0-9a-f]{64}/);
    // The spaCy model is pinned to an exact version (not `spacy download`).
    expect(redactionDockerfile).toMatch(/en_core_web_lg-3\.8\.0-py3-none-any\.whl/);
    expect(redactionDockerfile).not.toMatch(/spacy download/);
    expect(redactionDockerfile).toMatch(/FROM python@sha256:[0-9a-f]{64}/);
  });

  it('QS-4: the main Caddyfile no longer serves the console vhosts; they live in the consoles profile', () => {
    expect(caddyMain).not.toContain('reverse_proxy minio:9001');
    expect(caddyMain).not.toContain('reverse_proxy qdrant:6333');
    // The consoles service is bound to localhost only.
    expect(compose).toContain('caddy-consoles');
    expect(compose).toMatch(/profiles:\s*\['consoles'\]/);
    expect(compose).toContain('127.0.0.1:8443:443');
    // Qdrant gets an API key wired from config.
    expect(compose).toContain('QDRANT__SERVICE__API_KEY');
  });

  it('QS-8: a preflight init container guards known dev secrets and app/worker/zitadel depend on it', () => {
    expect(compose).toContain('preflight.js');
    // Each long-running service waits for the preflight to complete.
    const preflightWaits = compose.match(
      /preflight:\s*\n\s*condition: service_completed_successfully/g,
    );
    expect((preflightWaits ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('QS-9: app mounts the public-key-only volume; the worker keeps the full pair', () => {
    expect(compose).toContain('instance-pubkey:/instance-keys:ro'); // app
    expect(compose).toContain('instance-keys:/instance-keys:ro'); // worker
    expect(compose).toContain("COGETO_ASSERT_NO_PRIVATE_KEY: '1'");
    // migrate publishes the public half into the app-only volume.
    expect(compose).toContain('COGETO_INSTANCE_PUBKEY_DIR: /instance-pubkey');
  });

  it('searx_internal_only: the SearXNG service is profile-gated and never publicly exposed', () => {
    // The research profile exists and carries the searxng service.
    expect(compose).toMatch(/searxng:\s*\n\s*profiles:\s*\['research'\]/);
    // Internal-network only: the searxng service block declares NO ports
    // mapping (decision 0042) — discovery is reachable solely by the app over
    // the compose network. Extract the service block (up to the next top-level
    // two-space-indented service key) and assert.
    const block = compose.match(/\n {2}searxng:\n(?: {4}.*\n| *\n)+/)?.[0];
    expect(block, 'searxng service block not found').toBeTruthy();
    expect(block).not.toContain('ports:');
    // And the edge never proxies it: the only public vhost stays app-only.
    expect(caddyMain).not.toContain('searxng');
  });

  it('QS-24: the Zitadel masterkey is not on the command line', () => {
    expect(compose).toContain('--masterkeyFromEnv');
    expect(compose).not.toContain('--masterkey "');
  });
});

describe('app key-mount guard (QS-9)', () => {
  it('throws when the private key is reachable, and when the public key is missing', async () => {
    const both = mkdtempSync(path.join(tmpdir(), 'cogeto-keys-both-'));
    writeFileSync(path.join(both, PRIVATE_KEY_FILE), 'PRIVATE');
    writeFileSync(path.join(both, PUBLIC_KEY_FILE), 'PUBLIC');
    await expect(assertAppKeyMount(both)).rejects.toThrow(/private signing key is readable/);

    const pubOnly = mkdtempSync(path.join(tmpdir(), 'cogeto-keys-pub-'));
    writeFileSync(path.join(pubOnly, PUBLIC_KEY_FILE), 'PUBLIC');
    await expect(assertAppKeyMount(pubOnly)).resolves.toBeUndefined();

    const empty = mkdtempSync(path.join(tmpdir(), 'cogeto-keys-empty-'));
    await expect(assertAppKeyMount(empty)).rejects.toThrow(/public key is missing/);
  });
});

describe('zitadel-init hardening (decision 0034)', () => {
  const init = readFileSync(
    path.resolve(process.cwd(), '../..', 'project/infra/docker/zitadel-init/init.mjs'),
    'utf8',
  );

  it('hardens the login policy: no self-registration, no external IdP, no enumeration', () => {
    expect(init).toContain('allowRegister: false');
    expect(init).toContain('allowExternalIdp: false');
    expect(init).toContain('ignoreUnknownUsernames: true');
  });

  it('forbids public org registration at the instance level', () => {
    expect(init).toContain('disallowPublicOrgRegistration: true');
  });

  it('self-verifies by re-reading after every change (a silently-ignored field fails the boot)', () => {
    expect(init).toContain('did not stick');
  });
});
