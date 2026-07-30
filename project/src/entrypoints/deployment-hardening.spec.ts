import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertAppKeyMount, PRIVATE_KEY_FILE, PUBLIC_KEY_FILE } from '../infrastructure/index';

/**
 * deployment hardening — static assertions over the compose stack and
 * Dockerfiles plus the app key-mount guard.
 * Pure file reads; no container needed.
 */
const SRC = process.cwd();
const REPO = path.resolve(SRC, '../..');
const read = (rel: string): string => readFileSync(path.join(REPO, rel), 'utf8');

describe('deployment hardening', () => {
  const compose = read('docker-compose.yml');
  const dockerfile = read('project/infra/docker/Dockerfile');
  const caddyMain = read('project/infra/docker/caddy/Caddyfile');
  const redactionDockerfile = read('project/services/redaction/Dockerfile');
  // SEC-22: the customer stack and the mail image join the invariant.
  const deployCompose = read('project/infra/deploy/docker-compose.deploy.yml');
  const mailDockerfile = read('project/services/mail/Dockerfile');

  it('every image is pinned by digest (no floating tags)', () => {
    // `image:` lines must reference a digest, never a bare tag — in BOTH compose
    // files (SEC-22: this used to read the dev contract only, so an unpinned
    // image in the file customers actually run would have passed CI).
    for (const [name, text] of [
      ['docker-compose.yml', compose],
      ['docker-compose.deploy.yml', deployCompose],
    ] as const) {
      const imageLines = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('image:'));
      expect(imageLines.length, `${name} declares no images`).toBeGreaterThan(0);
      for (const line of imageLines) {
        // The deploy stack's own three images are released by tag from this
        // repo (cogeto/cogeto:${COGETO_VERSION}); everything upstream is pinned.
        if (line.includes('${COGETO_VERSION')) continue;
        expect(line, `unpinned image in ${name}: ${line}`).toMatch(/@sha256:[0-9a-f]{64}/);
      }
    }
    // The build stages are pinned too — in every Dockerfile we ship.
    expect(dockerfile).not.toMatch(/^FROM node:22-alpine/m);
    expect(dockerfile).toMatch(/FROM node@sha256:[0-9a-f]{64}/);
    expect(dockerfile).toMatch(/FROM caddy@sha256:[0-9a-f]{64}/);
    // SEC-22: the mail service parses hostile internet input and was not
    // covered by this invariant at all.
    expect(mailDockerfile).not.toMatch(/^FROM node:22-alpine/m);
    expect(mailDockerfile).toMatch(/FROM node@sha256:[0-9a-f]{64}/);
    // The spaCy model is pinned to an exact version (not `spacy download`).
    expect(redactionDockerfile).toMatch(/en_core_web_lg-3\.8\.0-py3-none-any\.whl/);
    expect(redactionDockerfile).not.toMatch(/spacy download/);
    expect(redactionDockerfile).toMatch(/FROM python@sha256:[0-9a-f]{64}/);
  });

  it('no image comment claims a tag that names no release (SEC-35)', () => {
    // A digest pinned against `# something:latest` is unauditable: the running
    // version cannot be recovered, so no advisory can be matched to it.
    for (const [name, text] of [
      ['docker-compose.yml', compose],
      ['docker-compose.deploy.yml', deployCompose],
      ['Dockerfile', dockerfile],
      ['services/mail/Dockerfile', mailDockerfile],
      ['services/redaction/Dockerfile', redactionDockerfile],
    ] as const) {
      const floating = text
        .split('\n')
        .filter((l) => l.trim().startsWith('#') && /\b[\w./-]+:latest\b/.test(l));
      expect(floating, `${name} pins a digest against a :latest comment`).toEqual([]);
    }
  });

  it('the main Caddyfile no longer serves the console vhosts; they live in the consoles profile', () => {
    expect(caddyMain).not.toContain('reverse_proxy minio:9001');
    expect(caddyMain).not.toContain('reverse_proxy qdrant:6333');
    // The consoles service is bound to localhost only.
    expect(compose).toContain('caddy-consoles');
    expect(compose).toMatch(/profiles:\s*\['consoles'\]/);
    expect(compose).toContain('127.0.0.1:8443:443');
    // Qdrant gets an API key wired from config.
    expect(compose).toContain('QDRANT__SERVICE__API_KEY');
  });

  it('a preflight init container guards known dev secrets and app/worker/zitadel depend on it', () => {
    expect(compose).toContain('preflight.js');
    // Each long-running service waits for the preflight to complete.
    const preflightWaits = compose.match(
      /preflight:\s*\n\s*condition: service_completed_successfully/g,
    );
    expect((preflightWaits ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('app mounts the public-key-only volume; the worker keeps the full pair', () => {
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
    // mapping — discovery is reachable solely by the app over
    // the compose network. Extract the service block (up to the next top-level
    // two-space-indented service key) and assert.
    const block = compose.match(/\n {2}searxng:\n(?: {4}.*\n| *\n)+/)?.[0];
    expect(block, 'searxng service block not found').toBeTruthy();
    expect(block).not.toContain('ports:');
    // And the edge never proxies it: the only public vhost stays app-only.
    expect(caddyMain).not.toContain('searxng');
  });

  it('the Zitadel masterkey is not on the command line', () => {
    expect(compose).toContain('--masterkeyFromEnv');
    expect(compose).not.toContain('--masterkey "');
  });

  describe('least-privilege data plane (audit 2.0 wave 3)', () => {
    const deployCaddy = read('project/infra/deploy/Caddyfile');

    it('SEC-1: no service connects to Postgres as the superuser', () => {
      for (const [name, text] of [
        ['docker-compose.yml', compose],
        ['docker-compose.deploy.yml', deployCompose],
      ] as const) {
        expect(text, `${name} still hands the superuser to a service`).not.toMatch(
          /COGETO_DATABASE_URL: postgres:\/\/postgres:/,
        );
        expect(text).toMatch(/COGETO_DATABASE_URL: postgres:\/\/cogeto_app:/);
        expect(text).toMatch(/COGETO_DATABASE_URL: postgres:\/\/cogeto_migrate:/);
        // The db-init one-shot provisions the roles; migrate and zitadel wait
        // for it.
        expect(text).toContain('db-init.sql');
        expect(text).toMatch(/ZITADEL_DATABASE_POSTGRES_ADMIN_USERNAME: zitadel_admin/);
        expect(text).not.toMatch(/ZITADEL_DATABASE_POSTGRES_ADMIN_USERNAME: postgres/);
      }
    });

    it('SEC-2: the app never holds the MinIO root credential', () => {
      for (const [name, text] of [
        ['docker-compose.yml', compose],
        ['docker-compose.deploy.yml', deployCompose],
      ] as const) {
        expect(text, `${name} maps a root credential into the app env`).not.toMatch(
          /COGETO_S3_ACCESS_KEY: \$\{MINIO_ROOT_USER/,
        );
        expect(text).not.toMatch(/COGETO_S3_SECRET_KEY: \$\{MINIO_ROOT_PASSWORD/);
        // minio-init provisions the scoped user and self-verifies both ways:
        // object access works, admin API refused.
        expect(text).toContain('mc admin policy create local cogeto-app-rw');
        expect(text).toContain('admin API refused');
      }
    });

    it('SEC-2: the public s3. vhost serves presigned GET/HEAD on the bucket only', () => {
      const vhost = deployCaddy.match(/s3\.\{\$COGETO_EXTERNAL_DOMAIN\} \{[\s\S]*?\n\}/)?.[0];
      expect(vhost, 's3 vhost not found in the production Caddyfile').toBeTruthy();
      expect(vhost).toContain('method GET HEAD');
      expect(vhost).toContain('path /cogeto/*');
      expect(vhost).toContain('respond 403');
      // No unconditional proxy line outside the matcher-gated handle.
      expect(vhost).not.toMatch(/\n\treverse_proxy minio:9000/);
    });

    it('SEC-16: the bootstrap PAT expiry is configurable and required on deploy', () => {
      expect(compose).toContain('${ZITADEL_BOOTSTRAP_PAT_EXPIRY:-');
      expect(deployCompose).toContain('${ZITADEL_BOOTSTRAP_PAT_EXPIRY:?}');
    });
  });
});

describe('app key-mount guard', () => {
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

describe('zitadel-init hardening', () => {
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

  it('SEC-16: revokes the bootstrap PAT after provisioning and self-verifies the refusal', () => {
    expect(init).toContain('revokeBootstrapPat');
    expect(init).toContain('/pats/_search');
    // The success criterion is behavioural: the token must stop authenticating.
    expect(init).toMatch(/probe\.status === 401/);
    // Later runs short-circuit on the recorded state instead of needing a PAT.
    expect(init).toContain('shortCircuitFromState');
    expect(init).toContain('bootstrap-state.json');
  });
});
