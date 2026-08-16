import { mkdtempSync, writeFileSync } from 'node:fs';
import { readdirSync, readFileSync } from 'node:fs';
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

/** One compose service's block: its key line through to the next service key. */
const serviceBlock = (compose: string, name: string): string => {
  const start = compose.indexOf(`\n  ${name}:\n`);
  if (start < 0) return '';
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z0-9-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

/**
 * Every Dockerfile in the repository, repo-relative. Walked rather than listed
 * so a new one is covered by the pin invariant the day it appears.
 */
const everyDockerfile = (dir = REPO, acc: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'cache'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) everyDockerfile(full, acc);
    else if (/^Dockerfile(\..+)?$/.test(entry.name)) acc.push(path.relative(REPO, full));
  }
  return acc;
};

/** Every service key declared under `services:` (not under `volumes:`). */
const serviceNames = (compose: string): string[] => {
  const body = compose.slice(compose.indexOf('\nservices:\n'));
  const end = body.indexOf('\nvolumes:\n');
  return [...(end < 0 ? body : body.slice(0, end)).matchAll(/\n {2}([a-z0-9-]+):\n/g)].map(
    (m) => m[1]!,
  );
};

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
    // The build stages are pinned too — in every Dockerfile we ship. The pin
    // carries the tag IN the reference (`node:24-alpine@sha256:…`) so
    // Dependabot tracks the intended tag instead of `latest`; a tag without a
    // digest is still a floating pull and stays forbidden.
    expect(dockerfile).not.toMatch(/^FROM node:24-alpine(?!@sha256:)/m);
    expect(dockerfile).toMatch(/FROM node:24-alpine@sha256:[0-9a-f]{64}/);
    expect(dockerfile).toMatch(/FROM caddy:2-alpine@sha256:[0-9a-f]{64}/);
    // SEC-22: the mail service parses hostile internet input and was not
    // covered by this invariant at all.
    expect(mailDockerfile).not.toMatch(/^FROM node:24-alpine(?!@sha256:)/m);
    expect(mailDockerfile).toMatch(/FROM node:24-alpine@sha256:[0-9a-f]{64}/);
    // The spaCy model is pinned to an exact version (not `spacy download`).
    expect(redactionDockerfile).toMatch(/en_core_web_lg-3\.8\.0-py3-none-any\.whl/);
    expect(redactionDockerfile).not.toMatch(/spacy download/);
    expect(redactionDockerfile).toMatch(/FROM python:3\.12-slim@sha256:[0-9a-f]{64}/);
  });

  it('every digest pin records the real tag it resolves to (SEC-35, tightened by issue #568)', () => {
    // A digest is unauditable on its own: without the tag it resolves to, the
    // running version cannot be recovered, so no advisory can be matched to
    // it. The tag used to live in a comment above the pin, which had two
    // failure modes this check has already caught in the wild: no comment at
    // all (the SearXNG pin, issue #568), and a comment that silently went
    // stale when the digest moved (the 2026-08 Dependabot wave). The tag now
    // lives IN the reference (`image:tag@sha256:…`), so it cannot be omitted,
    // cannot drift separately from the digest, and is what Dependabot tracks.
    // Both composes plus EVERY Dockerfile in the repository, DISCOVERED rather
    // than listed (issue #592): a hardcoded list covers the files that existed
    // when it was written, and the finding this check exists for was an image
    // nobody remembered to add.
    const pinFiles = [
      ['docker-compose.yml', compose],
      ['docker-compose.deploy.yml', deployCompose],
      ...everyDockerfile().map((rel) => [rel, read(rel)] as const),
    ] as const;
    // The three shipped Dockerfiles are the floor; discovery must not silently
    // find fewer than the files this repository is known to have.
    expect(pinFiles.length).toBeGreaterThanOrEqual(5);

    // `name:tag@sha256:<digest>` with a real tag: `latest` names no release,
    // so it is not a recorded tag, and a bare `name@sha256:` hides the
    // version entirely.
    const TAGGED_PIN = /^[\w][\w./-]*:[\w][\w.+-]*@sha256:[0-9a-f]{64}$/;
    for (const [name, text] of pinFiles) {
      const lines = text.split('\n');
      let checked = 0;
      for (const [index, line] of lines.entries()) {
        const trimmed = line.trim();
        const isPin =
          /@sha256:[0-9a-f]{64}/.test(trimmed) &&
          (trimmed.startsWith('image:') || trimmed.startsWith('FROM '));
        if (!isPin) continue;
        checked += 1;
        const ref = trimmed
          .replace(/^image:\s*/, '')
          .replace(/^FROM\s+/, '')
          .replace(/\s+AS\s+.*$/i, '');
        expect(
          TAGGED_PIN.test(ref) && !/:latest@/.test(ref),
          `${name}:${index + 1} pins a digest without the tag in the reference: ${trimmed}. ` +
            `Pin as '<image>:<tag>@sha256:<digest>' naming the release the digest resolves to ` +
            `(docs/operations/image-pins.md).`,
        ).toBe(true);
      }
      expect(checked, `${name} declares no digest pins — did the walk break?`).toBeGreaterThan(0);
    }
  });

  it('production_image_carries_no_dev_entrypoint: every dev/demo CLI is removed from the runtime stage', () => {
    // The audit's R7 check, as an invariant (V2.0 item 3.7). The Dockerfile
    // deletes the compiled dev entrypoints from the runtime stage; nothing
    // failed the build if a NEW one was added and not deleted, so the check
    // existed only as long as someone re-ran the audit.
    //
    // The rule is derived from the source tree, not from a second list to keep
    // in sync: any `entrypoints/{seed,demo}-*.ts` must be named in the `rm`.
    //
    // Issue #594 widens it to the EVALUATION harness — `eval*.ts` and the two
    // `*-smoke.ts` tools. They are npm-script and CI tools whose corpora are
    // not in the image; nothing on an instance runs them, so shipping them puts
    // a tool on a customer box that reads as supported and is not. The two
    // documented one-shot repair tools are deliberately NOT matched here: an
    // operator is told to run them.
    const runtimeStage = dockerfile.slice(dockerfile.indexOf('AS runtime'));
    const devEntrypoints = readdirSync(path.join(REPO, 'project/src/entrypoints'))
      .filter((name) => !name.endsWith('.spec.ts'))
      .filter((name) => /^(seed|demo)-[a-z-]+\.ts$|^eval(-[a-z-]+)?\.ts$|-smoke\.ts$/.test(name))
      .map((name) => name.replace(/\.ts$/, ''));
    expect(devEntrypoints.length).toBeGreaterThan(0);
    for (const name of devEntrypoints) {
      expect(
        runtimeStage,
        `project/src/dist/entrypoints/${name}.js ships in the production image`,
      ).toContain(`project/src/dist/entrypoints/${name}.js`);
    }
    // Source maps go with them (SEC-32): the production build turns them off,
    // and this is the assertion that keeps that config from drifting back.
    expect(read('project/src/tsconfig.build.json')).toMatch(/"sourceMap":\s*false/);
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
    expect(serviceBlock(compose, 'searxng')).toMatch(/profiles:\s*\['research'\]/);
    // Internal-network only: the searxng service block declares NO ports
    // mapping — discovery is reachable solely by the app over
    // the compose network. Extract the service block (up to the next top-level
    // two-space-indented service key) and assert.
    const block = serviceBlock(compose, 'searxng');
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

  describe('edge and container hardening (audit 2.0 wave 4)', () => {
    const deployCaddy = read('project/infra/deploy/Caddyfile');
    const operator = read('scripts/operator/cogeto');

    it('SEC-14: inbound SMTP is behind the `mail` profile in BOTH compose files', () => {
      // The finding: the mail service had no `profiles:` key and published
      // 0.0.0.0:25, so every instance ran an internet-facing Haraka listener
      // whether or not it used email capture, with no supported way off.
      for (const [name, text] of [
        ['docker-compose.yml', compose],
        ['docker-compose.deploy.yml', deployCompose],
      ] as const) {
        const mail = serviceBlock(text, 'mail');
        expect(mail, `${name} declares no mail service`).not.toBe('');
        expect(mail, `${name}: mail is not profile-gated`).toMatch(/profiles:\s*\['mail'\]/);
        // It still publishes 25 when the profile IS up — the port is the point
        // of the capability, the DEFAULT is what changed.
        expect(mail).toContain(':2525');
      }
    });

    it('SEC-14: the operator script gates the ufw rule for 25 on the capability', () => {
      // Install no longer opens 25 unconditionally …
      const openFirewall = operator.slice(
        operator.indexOf('open_firewall() {'),
        operator.indexOf('mail_capability_enabled() {'),
      );
      expect(openFirewall).toContain('mail_capability_enabled');
      expect(openFirewall).toMatch(/if mail_capability_enabled; then[\s\S]*?ufw allow 25\/tcp/);
      // … `features enable mail` opens it, `disable mail` closes it again.
      expect(operator).toContain('close_mail_firewall');
      expect(operator).toContain('ufw delete allow 25/tcp');
      // And it is a first-class capability of the features subcommand.
      expect(operator).toContain('FEATURE_IDS="redaction research mail demo consoles"');
    });

    it('SEC-17: every service in both compose files carries mem/cpu/pid ceilings', () => {
      for (const [name, text] of [
        ['docker-compose.yml', compose],
        ['docker-compose.deploy.yml', deployCompose],
      ] as const) {
        const names = serviceNames(text);
        expect(names.length, `${name} declares no services`).toBeGreaterThan(5);
        for (const service of names) {
          const block = serviceBlock(text, service);
          expect(block, `${name}: ${service} has no mem_limit`).toMatch(/\n {4}mem_limit: /);
          expect(block, `${name}: ${service} has no cpus`).toMatch(/\n {4}cpus: /);
          expect(block, `${name}: ${service} has no pids_limit`).toMatch(/\n {4}pids_limit: /);
        }
      }
    });

    it('F11: every service in both compose files drops all capabilities and no-new-privileges', () => {
      // The audit's finding was total: `cap_drop` 0, `security_opt` 0,
      // `read_only` 0, `user:` 0 across both files. The rule is per service and
      // has no exceptions, so it is asserted per service; what a service adds
      // BACK is the interesting part, and that is asserted below.
      for (const [name, text] of [
        ['docker-compose.yml', compose],
        ['docker-compose.deploy.yml', deployCompose],
      ] as const) {
        const names = serviceNames(text);
        expect(names.length, `${name} declares no services`).toBeGreaterThan(5);
        for (const service of names) {
          const block = serviceBlock(text, service);
          expect(block, `${name}: ${service} does not drop capabilities`).toMatch(
            /\n {4}cap_drop:\n {6}- ALL\n/,
          );
          expect(block, `${name}: ${service} does not set no-new-privileges`).toMatch(
            /\n {4}security_opt:\n {6}- no-new-privileges:true\n/,
          );
        }
      }
    });

    it('F11: a granted capability is the exception, and the mail service grants none', () => {
      // Every cap_add in either file, so a new grant has to be argued for in
      // review rather than appearing quietly. Verified by running real work
      // through the stack, not by watching containers start
      // (docs/security/instance-and-supply-chain-hardening.md).
      const GRANTS: Record<string, string[]> = {
        caddy: ['NET_BIND_SERVICE'],
        'caddy-consoles': ['NET_BIND_SERVICE'],
        'instance-keys-init': ['CHOWN'],
        'machinekey-init': ['CHOWN'],
        'mail-tls-sync': ['CHOWN'],
        'zitadel-init': ['DAC_OVERRIDE'],
        postgres: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'],
        searxng: ['CHOWN', 'DAC_OVERRIDE', 'SETGID', 'SETUID'],
      };
      for (const [name, text] of [
        ['docker-compose.yml', compose],
        ['docker-compose.deploy.yml', deployCompose],
      ] as const) {
        for (const service of serviceNames(text)) {
          const block = serviceBlock(text, service);
          const added = [...block.matchAll(/\n {4}cap_add:\n((?: {6}- [A-Z_]+\n)+)/g)]
            .flatMap((m) => m[1]!.split('\n'))
            .map((line) => line.replace(/^\s*-\s*/, '').trim())
            .filter(Boolean);
          expect(added.sort(), `${name}: ${service} grants an unexpected capability`).toEqual(
            (GRANTS[service] ?? []).slice().sort(),
          );
        }
      }
      // Stated as its own assertion because it is the counter-intuitive one:
      // the internet-facing mail service publishes port 25 on the HOST and
      // binds 2525 inside as a non-root user, so it needs nothing.
      for (const text of [compose, deployCompose]) {
        expect(serviceBlock(text, 'mail')).not.toContain('cap_add');
      }
    });

    it('F11: the processes that hold the corpus run on a read-only root', () => {
      // app and worker are the two long-running processes that touch memory
      // content. Both write nothing outside a mount, so a writable root buys an
      // attacker a place to stage; /tmp is a tmpfs that dies with the container.
      for (const text of [compose, deployCompose]) {
        for (const service of ['app', 'worker'] as const) {
          const block = serviceBlock(text, service);
          expect(block, `${service} has no read-only root`).toMatch(/\n {4}read_only: true\n/);
          expect(block, `${service} has no tmpfs for /tmp`).toMatch(/\n {6}- \/tmp:size=/);
        }
      }
      // Qdrant is the recorded exception, with its reason in the file: it
      // panics at startup under a read-only root.
      for (const text of [compose, deployCompose]) {
        const block = serviceBlock(text, 'qdrant');
        expect(block).not.toMatch(/\n {4}read_only: true\n/);
        expect(block).toContain('.qdrant-initialized');
      }
    });

    it('SEC-17: the ceilings are generous where the service actually needs room', () => {
      // A limit that kills a service under normal load is worse than no limit.
      // These are the three the audit named: the redaction sidecar is
      // documented near 1 GB, and Postgres/Qdrant/the worker hold real corpora.
      for (const text of [compose, deployCompose]) {
        expect(serviceBlock(text, 'worker')).toMatch(/mem_limit: 3g/);
        expect(serviceBlock(text, 'postgres')).toMatch(/mem_limit: 2g/);
        expect(serviceBlock(text, 'qdrant')).toMatch(/mem_limit: 2g/);
        // The redaction sidecar is in BOTH files since issue #565, and the
        // ceiling the SEC-17 note budgets for it must be the one it gets: the
        // sidecar is the single largest addition to a customer instance's
        // footprint, so an under-budgeted cap here OOM-kills the capability
        // that is supposed to keep PII on the box.
        expect(serviceBlock(text, 'redaction')).toMatch(/mem_limit: 2g/);
      }
    });

    it('SEC-28: security headers are applied to /api/* as well as the SPA', () => {
      for (const [name, text] of [
        ['dev Caddyfile', caddyMain],
        ['deploy Caddyfile', deployCaddy],
      ] as const) {
        const api = text.slice(text.indexOf('handle /api/*'), text.indexOf('# The SPA'));
        expect(api, `${name}: /api/* block not found`).not.toBe('');
        expect(api, `${name}: no nosniff on API responses`).toContain(
          'X-Content-Type-Options "nosniff"',
        );
        expect(api).toContain('X-Frame-Options "DENY"');
        expect(api).toContain('Referrer-Policy "no-referrer"');
        expect(api).toContain('Content-Security-Policy');
        expect(api).toContain('Strict-Transport-Security');
      }
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
