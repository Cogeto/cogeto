import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
// The manifest generator is the single definition of which deployment assets
// exist and what their checksums are (SEC-13); the spec asserts against it
// rather than re-deriving the list.
// @ts-expect-error -- plain .mjs CI script, no type declarations by design
import {
  buildManifest,
  DEPLOY_ASSETS,
  MANIFEST_PATH,
} from '../../../scripts/ci/deploy-assets-manifest.mjs';

/**
 * — the operator script and the pull-only deploy channel
 *. Three groups
 *
 *   1. The script's CLI contract: --help, argument validation, and the --check
 *      dry run (validates prerequisites, prints intended actions and the
 *      checklist, mutates NOTHING) — exercisable in CI on any machine.
 *   2. The pure helpers (secret formats, inbound-address derivation, version
 *      comparison), unit-tested by sourcing the script.
 *   3. Static hardening assertions over the deploy channel files, mirroring
 *      deployment-hardening.spec.ts: the customer stack never builds, keeps
 *      infra digest-pinned, requires secrets, and carries no demo.
 */
const SRC = process.cwd();
const REPO = path.resolve(SRC, '../..');
const SCRIPT = path.join(REPO, 'scripts', 'operator', 'cogeto');
const read = (rel: string): string => readFileSync(path.join(REPO, rel), 'utf8');

// A root that must never exist: --check must not create it.
const GHOST_ROOT = path.join(tmpdir(), `cogeto-operator-spec-${process.pid}`);

function runScript(args: string[]): { status: number; out: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/** Source the script (execution is guarded) and run one helper function. */
function helper(expression: string): { status: number; out: string } {
  const r = spawnSync('bash', ['-c', `source '${SCRIPT}'; ${expression}`], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: r.status ?? -1, out: r.stdout.trim() };
}

describe('operator script — CLI contract', () => {
  it('--help prints the full usage and exits 0', () => {
    const { status, out } = runScript(['--help']);
    expect(status).toBe(0);
    for (const word of ['install', 'configure', 'upgrade', 'status', 'backup-info', '--check']) {
      expect(out).toContain(word);
    }
    expect(out).toContain('WHAT YOU MUST DO NOW');
  });

  it('no subcommand prints usage and exits nonzero', () => {
    const { status, out } = runScript([]);
    expect(status).toBe(1);
    expect(out).toContain('Usage:');
  });

  it('an unknown argument is refused with a pointer to --help', () => {
    const { status, out } = runScript(['--frobnicate']);
    expect(status).toBe(1);
    expect(out).toContain('--help');
  });

  it('install refuses a malformed version', () => {
    const { status, out } = runScript(['install', '--check', '--version', '1.2']);
    expect(status).toBe(1);
    expect(out).toContain('X.Y.Z');
  });

  it('install refuses retired (pre-release-flagged) releases', () => {
    // v0.8.0 is published but flagged pre-release on GitHub; the script must
    // refuse it and point at the supported line. (Live API call — CI has
    // network; the check-mode fallback only tolerates an UNREACHABLE API.)
    const { status, out } = runScript([
      'install',
      '--check',
      '--root',
      GHOST_ROOT,
      '--domain',
      'acme.cogeto.eu',
      '--acme-email',
      'ops@cogeto.eu',
      '--version',
      '0.8.0',
    ]);
    expect(status).toBe(1);
    expect(out).toContain('retired');
  });

  it('install refuses an invalid domain', () => {
    const { status, out } = runScript([
      'install',
      '--check',
      '--root',
      GHOST_ROOT,
      '--domain',
      'not_a_domain',
      '--acme-email',
      'ops@cogeto.eu',
    ]);
    expect(status).toBe(1);
    expect(out).toContain('not a valid domain');
  });

  it('upgrade and status refuse to run against a machine with no instance', () => {
    for (const sub of ['upgrade', 'status']) {
      const { status, out } = runScript([sub, '--check', '--root', GHOST_ROOT]);
      expect(status).toBe(1);
      expect(out).toContain('no instance found');
    }
  });

  it('upgrade self-heals the PATH install (a re-downloaded script run via `upgrade` must still yield a working `sudo cogeto`)', () => {
    // A fake installed instance pinned to the target version: upgrade takes
    // the "already on" early exit — no network, no confirmation — but the
    // self-install intent must already have been announced.
    const root = mkdtempSync(path.join(tmpdir(), 'cogeto-operator-upgrade-'));
    writeFileSync(path.join(root, '.env'), 'COGETO_VERSION=9.9.9\n', { mode: 0o600 });
    const { status, out } = runScript(['upgrade', '9.9.9', '--check', '--root', root]);
    rmSync(root, { recursive: true, force: true });
    expect(status).toBe(0);
    expect(out).toContain('/usr/local/bin/cogeto');
    expect(out).toContain('already on v9.9.9');
  });

  it('backup-info prints the OVHcloud settings (D4) and performs nothing', () => {
    const { status, out } = runScript(['backup-info']);
    expect(status).toBe(0);
    expect(out).toContain('Automated Backup');
    expect(out).toContain('instance-keys');
  });
});

describe('operator script — install --check dry run', () => {
  const { status, out } = runScript([
    'install',
    '--check',
    '--root',
    GHOST_ROOT,
    '--domain',
    'acme.cogeto.eu',
    '--acme-email',
    'ops@cogeto.eu',
  ]);

  it('completes with exit 0 and announces check mode', () => {
    expect(status).toBe(0);
    expect(out).toContain('CHECK MODE');
  });

  it('resolves the latest release and surfaces the version confirmation', () => {
    expect(out).toMatch(/would ask: install Cogeto v\d+\.\d+\.\d+ \(latest published release\)\?/);
  });

  it('mutates nothing — the target root is never created', () => {
    expect(existsSync(GHOST_ROOT)).toBe(false);
  });

  it('prints the intended actions instead of running them', () => {
    expect(out).toContain('[dry-run] would run: compose pull');
    expect(out).toContain('[dry-run] would run: compose up -d');
    expect(out).toContain('[dry-run] would fetch');
    // The fetched deploy assets are pinned to the release tag.
    expect(out).toContain('project/infra/deploy/docker-compose.deploy.yml');
    // The research profile's SearXNG settings ship with the deploy assets
    // so `features enable research` works later.
    expect(out).toContain('project/infra/docker/searxng/settings.yml');
  });

  it('prints the cosign verify commands for all three published images', () => {
    for (const img of ['cogeto/cogeto:', 'cogeto/cogeto-edge:', 'cogeto/cogeto-mail:']) {
      expect(out).toContain(`cosign verify ${img}`);
    }
  });

  it('installs cosign and itself (o6-dry-run: an optional verifier gets skipped; "cogeto status" must exist on PATH)', () => {
    // Depending on the machine, cosign is either about to be installed or
    // already present — both surface explicitly.
    expect(out).toMatch(/would install cosign|cosign already installed/);
    expect(out).toContain('/usr/local/bin/cogeto');
  });

  it('ends with the instance-specific WHAT YOU MUST DO NOW checklist', () => {
    expect(out).toContain('WHAT YOU MUST DO NOW');
    // Real values, not placeholders (addressing scheme).
    expect(out).toContain('acme.cogeto.eu.  IN A');
    expect(out).toContain('s3.acme.cogeto.eu.  IN A');
    expect(out).toContain('capture@in.acme.cogeto.eu');
    // SEC-14: a fresh install runs NO inbound SMTP listener, so the MX / PTR /
    // SPF steps must NOT be on the checklist — they would tell the operator to
    // point real mail at something that is not there. What is on the checklist
    // is how to turn it on.
    expect(out).not.toContain('IN MX 10');
    expect(out).not.toContain('Edit the reverse');
    expect(out).toContain('Email capture is OFF on this instance');
    expect(out).toContain('cogeto features enable mail');
    expect(out).toContain('allow inbound TCP 80 and 443');
    expect(out).toContain('Automated Backup');
    // The step that now matters: models are configured in the interface after
    // login. The checklist names it, with the surface and the consequence.
    expect(out).toContain('Configure a model provider');
    expect(out).toContain('Providers (left rail)');
    // And the dead instruction is gone: nothing anywhere in an install run may
    // mention a model key in the environment.
    expect(out.toLowerCase()).not.toContain('mistral');
    // Grouped by immediacy, checkbox-style.
    expect(out).toContain('Do now:');
    expect(out).toContain('Verify after DNS propagates:');
    expect(out).toContain('[ ]');
  });

  it('checklist items carry the HOW (o6-dry-run detail pass)', () => {
    // DNS propagation + automatic ACME retry, right next to the records.
    expect(out).toContain('propagation takes minutes');
    expect(out).toContain('AUTOMATICALLY');
    // Create-user guidance: console URL, initial password, the no-SMTP trap.
    expect(out).toContain('/ui/console');
    expect(out).toContain('Set initial password');
    expect(out).toContain('no outbound SMTP');
    // The status command as it actually works after self-install.
    expect(out).toContain('sudo cogeto status');
  });

  it('never logs a secret value — only the names being set', () => {
    expect(out).toContain('would set POSTGRES_PASSWORD');
    expect(out).toContain('would set COGETO_MAIL_INTAKE_TOKEN');
    // gen_token produces 64 hex chars; no such value may appear in output.
    expect(out).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe('operator script — pure helpers', () => {
  it('version_cmp orders semver numerically, not lexically', () => {
    expect(helper('version_cmp 1.2.3 1.10.0').out).toBe('-1');
    expect(helper('version_cmp 2.0.0 2.0.0').out).toBe('0');
    expect(helper('version_cmp 0.10.1 0.9.9').out).toBe('1');
  });

  it('semver_valid accepts X.Y.Z only', () => {
    expect(helper('semver_valid 1.2.3 && echo yes').out).toBe('yes');
    expect(helper('semver_valid v1.2.3 || echo no').out).toBe('no');
    expect(helper('semver_valid 1.2 || echo no').out).toBe('no');
    expect(helper('semver_valid latest || echo no').out).toBe('no');
  });

  it('carries no version constants — GitHub release flags are the policy', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).not.toContain('DEFAULT_VERSION');
    expect(script).not.toContain('MIN_VERSION');
    expect(script).toContain('GH_RELEASES_API');
    expect(script).toContain('require_supported_version');
  });

  it('derives the per-tenant addressing scheme', () => {
    expect(helper('derive_inbound_address acme.cogeto.eu').out).toBe('capture@in.acme.cogeto.eu');
    expect(helper('derive_inbound_subdomain acme.cogeto.eu').out).toBe('in.acme.cogeto.eu');
    expect(helper('derive_mx_host acme.cogeto.eu').out).toBe('mail.acme.cogeto.eu');
    expect(helper('derive_s3_origin acme.cogeto.eu').out).toBe('https://s3.acme.cogeto.eu');
  });

  it('domain_valid rejects junk and accepts real domains', () => {
    expect(helper('domain_valid acme.cogeto.eu && echo yes').out).toBe('yes');
    expect(helper('domain_valid "not a domain" || echo no').out).toBe('no');
    expect(helper('domain_valid "https://acme.eu" || echo no').out).toBe('no');
    expect(helper('domain_valid localhost || echo no').out).toBe('no');
  });

  it('generates secrets in the formats the stack requires', () => {
    // Zitadel masterkey MUST be exactly 32 characters.
    expect(helper('gen_zitadel_masterkey').out).toMatch(/^[A-Za-z0-9]{32}$/);
    // General passwords: 32 alphanumerics (URL/env/psql-safe).
    expect(helper('gen_password').out).toMatch(/^[A-Za-z0-9]{32}$/);
    // Tokens: 64 hex characters.
    expect(helper('gen_token').out).toMatch(/^[0-9a-f]{64}$/);
    // MinIO KMS: <key-name>:<base64 of 32 bytes>.
    const kms = helper('gen_minio_kms_key').out;
    expect(kms).toMatch(/^cogeto-instance-key:[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(kms.split(':')[1], 'base64')).toHaveLength(32);
    // Zitadel admin password must carry upper + lower + digit + symbol.
    const admin = helper('gen_zitadel_admin_password').out;
    expect(admin).toMatch(/[A-Z]/);
    expect(admin).toMatch(/[a-z]/);
    expect(admin).toMatch(/[0-9]/);
    expect(admin).toMatch(/[^A-Za-z0-9]/);
    expect(admin.length).toBeGreaterThanOrEqual(12);
    // Two calls never collide.
    expect(helper('gen_password').out).not.toBe(helper('gen_password').out);
    // SEC-16: the bootstrap PAT expiry is a near-future ISO date, not 2030.
    const expiry = helper('gen_bootstrap_pat_expiry').out;
    expect(expiry).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
    const days = (Date.parse(expiry) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(12);
    expect(days).toBeLessThan(16);
  });

  it('install generates the wave-3 credentials and upgrade backfills them (SEC-1/2/16)', () => {
    const script = read('scripts/operator/cogeto');
    // The install path sets every wave-3 secret...
    for (const name of [
      'COGETO_APP_DB_PASSWORD',
      'COGETO_MIGRATE_DB_PASSWORD',
      'ZITADEL_DB_ADMIN_PASSWORD',
      'COGETO_S3_ACCESS_KEY',
      'COGETO_S3_SECRET_KEY',
      'ZITADEL_BOOTSTRAP_PAT_EXPIRY',
      'COGETO_MASTER_KEY',
    ]) {
      expect(script).toContain(`env_set ${name} `);
    }
    // ...and the upgrade path backfills any the fetched compose now requires.
    // COGETO_MASTER_KEY is in the backfill set (audit F1): an instance
    // installed before it existed must get one on upgrade, and an existing
    // value is never touched.
    expect(script).toContain('ensure_wave3_secrets');
    const backfill = script.slice(
      script.indexOf('ensure_wave3_secrets() {'),
      script.indexOf('# SEC-14 upgrade continuity'),
    );
    expect(backfill).toContain('COGETO_MASTER_KEY');
    expect(backfill).toMatch(/\[ -n "\$\(env_get COGETO_MASTER_KEY\)" \]\s+\|\| env_set COGETO_MASTER_KEY/);
    // The db-init asset ships with the other pinned deploy files.
    expect(script).toContain('project/infra/docker/postgres-init/db-init.sql');
  });
});

describe('operator script — the script knows nothing about models', () => {
  it('install and configure refuse --mistral-key with the pointer at the interface', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cogeto-operator-nomodel-'));
    writeFileSync(path.join(root, '.env'), 'COGETO_VERSION=9.9.9\n', { mode: 0o600 });
    const install = runScript(['install', '--check', '--root', GHOST_ROOT, '--mistral-key', 'k']);
    expect(install.status).toBe(1);
    expect(install.out).toContain('configured in the interface');
    const configure = runScript(['configure', '--check', '--root', root, '--mistral-key', 'k']);
    rmSync(root, { recursive: true, force: true });
    expect(configure.status).toBe(1);
    expect(configure.out).toContain('configured in the interface');
  });

  it('the script never writes a model or provider variable', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    for (const name of [
      'COGETO_MISTRAL_API_KEY',
      'COGETO_PROVIDER_PRESET',
      'COGETO_OLLAMA_BASE_URL',
      'COGETO_MODEL_',
      'COGETO_PROVIDER_PIPELINE',
      'COGETO_PROVIDER_ANSWER',
      'COGETO_PROVIDER_EMBEDDINGS',
    ]) {
      expect(script, `${name} must not appear in the operator script`).not.toContain(name);
    }
  });

  it('status reads the model state from the running app, never from .env', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    const status = script.slice(script.indexOf('cmd_status() {'), script.indexOf('# ── features'));
    expect(status).toContain('model provider');
    expect(status).toContain('/api/health');
    // No env_get of any model variable inside status.
    expect(status).not.toMatch(/env_get [A-Z_]*(MISTRAL|MODEL|PROVIDER|OLLAMA)/);
  });

  it('every secret the deploy compose REQUIRES is generated or written by install', () => {
    // The audit found the whole-set check missing (the master key was the one
    // omission): assert the set itself, so a future required secret cannot
    // ship without its generator.
    const deploy = read('project/infra/deploy/docker-compose.deploy.yml');
    const script = readFileSync(SCRIPT, 'utf8');
    const install = script.slice(script.indexOf('cmd_install() {'), script.indexOf('# ── upgrade'));
    const required = [
      ...new Set([...deploy.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1]!)),
      // A documentation comment in the compose spells the ${VAR:?} form.
    ].filter((name) => name !== 'VAR');
    expect(required.length).toBeGreaterThan(10);
    for (const name of required) {
      // COGETO_VERSION and COGETO_EXTERNAL_DOMAIN are written too; ZITADEL_
      // ADMIN_USERNAME is derived from the domain. Everything required must be
      // env_set somewhere in the install path.
      expect(install, `install does not write required secret ${name}`).toContain(
        `env_set ${name} `,
      );
    }
    // The master key is required-by-function (it encrypts provider keys the
    // admin enters), even though compose leaves it optional so a keyless
    // self-hosted-only instance still boots.
    expect(install).toContain('env_set COGETO_MASTER_KEY ');
  });
});

describe('operator script — features', () => {
  const withEnv = (env: string): string => {
    const root = mkdtempSync(path.join(tmpdir(), 'cogeto-operator-features-'));
    writeFileSync(path.join(root, '.env'), env, { mode: 0o600 });
    return root;
  };

  it('--help documents the features subcommand and the capability set', () => {
    const { out } = runScript(['--help']);
    expect(out).toContain('cogeto features');
    for (const id of ['redaction', 'research', 'demo', 'consoles']) {
      expect(out).toContain(id);
    }
    // Models are configured in the interface: the script says so and offers
    // no model toggle of its own.
    expect(out).toContain('configured in the interface');
  });

  it('refuses to run against a machine with no instance', () => {
    const { status, out } = runScript(['features', '--check', '--root', GHOST_ROOT]);
    expect(status).toBe(1);
    expect(out).toContain('no instance found');
  });

  it('lists every capability with its configured state; health is honestly unknown with the stack down', () => {
    const root = withEnv('COGETO_VERSION=9.9.9\nCOMPOSE_PROFILES=research\nREDACTION_ENABLED=1\n');
    const { status, out } = runScript(['features', '--root', root]);
    rmSync(root, { recursive: true, force: true });
    expect(status).toBe(0);
    expect(out).toMatch(/redaction\s+enabled/);
    expect(out).toMatch(/research\s+enabled/);
    expect(out).toMatch(/demo\s+disabled/);
    expect(out).toMatch(/consoles\s+disabled/);
    expect(out).toContain('health unknown');
  });

  it('REFUSES to enable demo when the production flag is set — loudly', () => {
    const root = withEnv('COGETO_VERSION=9.9.9\nCOGETO_PRODUCTION=1\n');
    const { status, out } = runScript(['features', 'enable', 'demo', '--check', '--root', root]);
    rmSync(root, { recursive: true, force: true });
    expect(status).toBe(1);
    expect(out).toContain('REFUSING');
    expect(out).toContain('PRODUCTION');
  });

  it('an unknown id (and a missing id) lists the valid set', () => {
    const root = withEnv('COGETO_VERSION=9.9.9\n');
    const unknown = runScript(['features', 'enable', 'frobnicate', '--check', '--root', root]);
    expect(unknown.status).toBe(1);
    expect(unknown.out).toContain('redaction research mail demo consoles');
    const missing = runScript(['features', 'enable', '--check', '--root', root]);
    rmSync(root, { recursive: true, force: true });
    expect(missing.status).toBe(1);
    expect(missing.out).toContain('redaction research mail demo consoles');
  });

  it('--check enable research prints the intended edits and mutates nothing', () => {
    const env = 'COGETO_VERSION=9.9.9\n';
    const root = withEnv(env);
    const { status, out } = runScript([
      'features',
      'enable',
      'research',
      '--check',
      '--root',
      root,
    ]);
    const after = readFileSync(path.join(root, '.env'), 'utf8');
    rmSync(root, { recursive: true, force: true });
    expect(status).toBe(0);
    expect(out).toContain('would set SEARXNG_SECRET');
    expect(out).toContain('would set COMPOSE_PROFILES');
    expect(out).toContain('[dry-run] would run: compose up -d --remove-orphans');
    expect(after).toBe(env); // dry run: the instance configuration is untouched
  });

  it('disabling redaction demands the typed confirmation with the plaintext consequence', () => {
    const root = withEnv('COGETO_VERSION=9.9.9\nREDACTION_ENABLED=1\n');
    const { status, out } = runScript([
      'features',
      'disable',
      'redaction',
      '--check',
      '--root',
      root,
    ]);
    rmSync(root, { recursive: true, force: true });
    expect(status).toBe(0);
    expect(out).toContain("would ask you to type 'disable redaction'");
    expect(out).toContain('PLAINTEXT');
  });

  it('local-models is refused with the pointer at the interface — never a toggle that lies', () => {
    const root = withEnv('COGETO_VERSION=9.9.9\n');
    for (const verb of ['enable', 'disable']) {
      const { status, out } = runScript([
        'features',
        verb,
        'local-models',
        '--check',
        '--root',
        root,
      ]);
      expect(status).toBe(1);
      expect(out).toContain('no longer a script feature');
      expect(out).toContain('Providers');
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('disable is idempotent: an already-disabled capability is a stated no-op', () => {
    const root = withEnv('COGETO_VERSION=9.9.9\n');
    const { status, out } = runScript([
      'features',
      'disable',
      'research',
      '--check',
      '--root',
      root,
    ]);
    rmSync(root, { recursive: true, force: true });
    expect(status).toBe(0);
    expect(out).toContain('already disabled');
  });

  it('profile-list helpers are pure, normalized and idempotent', () => {
    expect(helper("profiles_add '' research").out).toBe('research');
    expect(helper("profiles_add 'research' research").out).toBe('research');
    expect(helper("profiles_add 'demo, consoles' research").out).toBe('demo,consoles,research');
    expect(helper("profiles_remove 'demo,research,consoles' research").out).toBe('demo,consoles');
    expect(helper("profiles_remove 'research' research").out).toBe('');
    expect(helper("profiles_has 'demo,research' research && echo yes").out).toBe('yes');
    expect(helper("profiles_has 'demo' research || echo no").out).toBe('no');
    expect(helper('feature_known redaction && echo yes').out).toBe('yes');
    expect(helper('feature_known frobnicate || echo no').out).toBe('no');
  });

  it('config editing (env_set) is idempotent and keeps the file at mode 600', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cogeto-operator-envset-'));
    const envFile = path.join(root, '.env');
    const r = spawnSync(
      'bash',
      [
        '-c',
        `source '${SCRIPT}'; CHECK=0; ENV_FILE='${envFile}'; ` +
          'env_set COMPOSE_PROFILES research; env_set COMPOSE_PROFILES research; ' +
          `cat '${envFile}'; stat -c '%a' '${envFile}' 2>/dev/null || stat -f '%Lp' '${envFile}'`,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    rmSync(root, { recursive: true, force: true });
    const lines = r.stdout.trim().split('\n');
    expect(lines).toEqual(['COMPOSE_PROFILES=research', '600']);
  });
});

describe('deploy channel — hardening assertions', () => {
  const deploy = read('project/infra/deploy/docker-compose.deploy.yml');
  const deployCaddy = read('project/infra/deploy/Caddyfile');
  const devCaddy = read('project/infra/docker/caddy/Caddyfile');
  const devCompose = read('docker-compose.yml');
  const release = read('.github/workflows/release.yml');

  it('the customer stack NEVER builds — no build: keys at all', () => {
    expect(deploy).not.toMatch(/^\s*build:/m);
  });

  it('the three Cogeto images are pulled at ${COGETO_VERSION}', () => {
    expect(deploy).toMatch(/image: cogeto\/cogeto:\$\{COGETO_VERSION/);
    expect(deploy).toMatch(/image: cogeto\/cogeto-edge:\$\{COGETO_VERSION/);
    expect(deploy).toMatch(/image: cogeto\/cogeto-mail:\$\{COGETO_VERSION/);
  });

  it('infra images stay pinned by digest, same digests as the dev stack', () => {
    const digests = (compose: string): string[] =>
      compose
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('image:') && !l.includes('cogeto/cogeto'))
        .map((l) => l.replace('image:', '').trim());
    const deployImages = digests(deploy);
    expect(deployImages.length).toBeGreaterThan(0);
    for (const image of deployImages) {
      expect(image, `not digest-pinned in deploy compose: ${image}`).toMatch(
        /@sha256:[0-9a-f]{64}$/,
      );
      // Drift guard: every infra digest must also exist in the dev compose.
      expect(devCompose, `digest differs from dev stack: ${image}`).toContain(image);
    }
  });

  it('secrets are REQUIRED — missing .env values fail loudly', () => {
    for (const key of [
      'POSTGRES_PASSWORD',
      'MINIO_ROOT_PASSWORD',
      'MINIO_KMS_SECRET_KEY',
      'ZITADEL_MASTERKEY',
      'ZITADEL_DB_PASSWORD',
      'ZITADEL_ADMIN_PASSWORD',
      'COGETO_QDRANT_API_KEY',
      'COGETO_MAIL_INTAKE_TOKEN',
    ]) {
      expect(deploy, `${key} must use the required \${VAR:?} form`).toMatch(
        new RegExp(`\\$\\{${key}:\\?`),
      );
    }
  });

  it('a customer instance is production: demo hard-refused, no dev profiles', () => {
    expect(deploy).toContain("COGETO_PRODUCTION: '1'");
    expect(deploy).not.toContain('COGETO_DEMO_MODE');
    // TWO optional profiles in the deploy channel: `research` (SearXNG, a
    // digest-pinned upstream image, still pull-only) and `mail` (SEC-14:
    // inbound SMTP is opt-in). The dev-only profiles (demo, dev-seed,
    // consoles) and the unpublished redaction sidecar stay absent.
    const profiles = [...deploy.matchAll(/profiles:\s*\[([^\]]*)\]/g)].map((m) => m[1]!.trim());
    expect(profiles).toEqual(["'research'", "'mail'"]);
    expect(deploy).not.toContain('demo-seed');
    expect(deploy).not.toContain('seed-object');
    expect(deploy).not.toContain('caddy-consoles');
    expect(deploy).not.toMatch(/^\s*redaction:/m);
  });

  it('SEC-13: cosign is verified against a pinned sha256 before it becomes executable', () => {
    // The whole image-provenance chain used to terminate in an unverified
    // binary downloaded as root: curl → chmod 0755 → /usr/local/bin.
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toMatch(/^COSIGN_SHA256="[0-9a-f]{64}"$/m);
    const install = script.slice(
      script.indexOf('install_cosign() {'),
      script.indexOf('# Put this script on PATH'),
    );
    // The order is the property: download, compare, THEN chmod/mv.
    const download = install.indexOf('curl -fsSL');
    const compare = install.indexOf('$COSIGN_SHA256');
    const chmod = install.indexOf('chmod 0755');
    expect(download).toBeGreaterThan(-1);
    expect(compare).toBeGreaterThan(download);
    expect(chmod).toBeGreaterThan(compare);
    expect(install).toContain('COSIGN CHECKSUM MISMATCH');
  });

  it('SEC-13: deployment assets are pinned by commit SHA and verified against a manifest', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    // No tag ref in the fetch path any more — a tag is mutable, a commit is not.
    const fetchBlock = script.slice(
      script.indexOf('fetch_deploy_assets() {'),
      script.indexOf('# The expected sha256 for one repo path'),
    );
    expect(fetchBlock).toContain('resolve_tag_commit');
    expect(fetchBlock).not.toMatch(/fetch_one "v\$\{version\}"/);
    // A missing manifest, a missing entry, or a mismatch each abort the run.
    expect(script).toContain('refusing to install unverified deployment files');
    expect(script).toContain('DEPLOYMENT FILE CHECKSUM MISMATCH');
    expect(script).toContain('refusing to install an unverified deployment file');
  });

  it('SEC-13: the checksum manifest covers exactly the files the installer fetches, and is current', async () => {
    const manifest = readFileSync(path.join(REPO, MANIFEST_PATH), 'utf8');
    // Current: regenerating from the working tree produces the same bytes.
    expect(manifest).toBe(await buildManifest(REPO));
    // Complete: every path the script fetches has an entry.
    const script = readFileSync(SCRIPT, 'utf8');
    const fetched = [...script.matchAll(/fetch_one "\$commit" "([^"]+)"/g)].map((m) => m[1]!);
    expect(fetched.length).toBeGreaterThan(0);
    for (const asset of fetched) {
      expect(manifest, `${asset} has no manifest entry`).toContain(`  ${asset}\n`);
    }
    expect(new Set(fetched)).toEqual(new Set(DEPLOY_ASSETS));
  });

  it('Qdrant API-key auth is always on in the deploy stack', () => {
    expect(deploy).toMatch(/QDRANT__SERVICE__API_KEY: \$\{COGETO_QDRANT_API_KEY/);
  });

  it('the mail service maps standard inbound SMTP to the non-root listener', () => {
    expect(deploy).toContain(":-25}:2525'");
  });

  it('the production Caddyfile serves the real domain with ACME, not local_certs', () => {
    expect(deployCaddy).toContain('{$COGETO_EXTERNAL_DOMAIN}');
    expect(deployCaddy).toContain('email {$COGETO_ACME_EMAIL}');
    expect(deployCaddy).not.toContain('local_certs');
    // The presign origin rides the same edge.
    expect(deployCaddy).toContain('s3.{$COGETO_EXTERNAL_DOMAIN}');
  });

  it('the production edge keeps the dev CSP verbatim ( — no drift)', () => {
    const csp = (file: string): string | undefined =>
      file.split('\n').find((l) => l.trim().startsWith('Content-Security-Policy'));
    expect(csp(deployCaddy)).toBeDefined();
    expect(csp(deployCaddy)?.trim()).toBe(csp(devCaddy)?.trim());
  });

  it('the release pipeline publishes and signs all three images', () => {
    expect(release).toContain('cogeto/cogeto-edge');
    expect(release).toContain('cogeto/cogeto-mail');
    expect(release).toContain('target: caddy');
    expect(release).toContain('context: project/services/mail');
    // One cosign sign per image digest.
    expect(release.match(/cosign sign --yes/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
