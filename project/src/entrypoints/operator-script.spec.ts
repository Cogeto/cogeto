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
    // A fake installed instance pinned to the target version, with no stack:
    // upgrade stops early — no network, no confirmation — but the self-install
    // intent must already have been announced.
    const root = mkdtempSync(path.join(tmpdir(), 'cogeto-operator-upgrade-'));
    writeFileSync(path.join(root, '.env'), 'COGETO_VERSION=9.9.9\n', { mode: 0o600 });
    const { status, out } = runScript(['upgrade', '9.9.9', '--check', '--root', root]);
    rmSync(root, { recursive: true, force: true });
    expect(status).toBe(0);
    expect(out).toContain('/usr/local/bin/cogeto');
    expect(out).toContain('the recorded version is already v9.9.9');
    // ...and it does NOT report that as a healthy no-op: an instance with no
    // app container is not fine, and the report says which is which.
    expect(out).toContain('NOTHING IS RUNNING');
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

  it('prints the cosign verify commands for every image THIS instance runs (three here; the redaction sidecar joins them when that capability is on)', () => {
    // A dry-run install has redaction off, so the fourth published image is
    // correctly absent from this list: `instance_images` is one list, and pull,
    // verify and the printed commands all read it, so they cannot disagree.
    for (const img of ['cogeto/cogeto:', 'cogeto/cogeto-edge:', 'cogeto/cogeto-mail:']) {
      expect(out).toContain(`cosign verify ${img}`);
    }
    expect(out).not.toContain('cosign verify cogeto/cogeto-redaction:');
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
    expect(backfill).toMatch(
      /\[ -n "\$\(env_get COGETO_MASTER_KEY\)" \]\s+\|\| env_set COGETO_MASTER_KEY/,
    );
    // The db-init asset ships with the other pinned deploy files.
    expect(script).toContain('project/infra/docker/postgres-init/db-init.sql');
  });
});

describe('operator script — a transient compose failure is never an upgrade accusation', () => {
  // compose_has_service used to conflate "the compose file lacks the service"
  // with "docker compose config failed", so a two-second daemon hiccup told
  // the operator their instance needed an upgrade (observed in CI,
  // 2026-08-16). The two must produce different messages, and only the
  // genuine absence may point at upgrading.
  const setup = 'd="$(mktemp -d)"; touch "$d/docker-compose.yml"; COGETO_ROOT="$d"; CHECK=0; ';

  it('a successful read that lacks the service refuses with the upgrade pointer', () => {
    const { status, out } = helper(
      setup +
        'compose() { echo minio; }; require_feature_service research searxng research "Upgrade first." 2>&1',
    );
    expect(status).toBe(1);
    expect(out).toContain("not in this instance's compose file");
  });

  it('a failed read dies with retry wording, never the upgrade accusation', () => {
    const { status, out } = helper(
      setup +
        'compose() { return 1; }; require_feature_service research searxng research "Upgrade first." 2>&1',
    );
    expect(status).toBe(1);
    expect(out).toContain('could not read the compose file just now');
    expect(out).not.toContain("not in this instance's compose file");
  });

  it('in check mode a failed read warns and continues instead of dying', () => {
    const { status, out } = helper(
      setup +
        'CHECK=1; compose() { return 1; }; require_feature_service research searxng research "Upgrade first." 2>&1; echo continued',
    );
    expect(status).toBe(0);
    expect(out).toContain('could not read the compose file just now');
    expect(out).toContain('continued');
  });

  it('a present service passes silently', () => {
    const { status, out } = helper(
      setup +
        'compose() { printf "searxng\\nminio\\n"; }; require_feature_service research searxng research "Upgrade first." && echo ok',
    );
    expect(status).toBe(0);
    expect(out).toBe('ok');
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

  /**
   * The capability lists are the registry's, or they lie (F15, and issue #602).
   *
   * `FEATURE_IDS` (what this script switches) plus `FEATURE_IDS_REPORTED_ONLY`
   * (what the registry reports and the script explains rather than switches)
   * must together be EXACTLY the `CapabilityId` set. That rule was checked only
   * by the full smoke harness, which needs a running stack, runs on merges to
   * main and does not block, so adding a tenth capability reproduced F15 inside
   * a pull request where every required check was green. This is the same
   * comparison, against the type instead of a live /api/health, inside `test`.
   */
  it('the two capability lists together are exactly the registry set', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    const listOf = (name: string): string[] => {
      const m = script.match(new RegExp(`^${name}="([^"]*)"$`, 'm'));
      expect(m, `${name} is not a plain quoted list in the operator script`).toBeTruthy();
      return m![1]!.split(/\s+/).filter(Boolean);
    };
    const switched = listOf('FEATURE_IDS');
    const reportedOnly = listOf('FEATURE_IDS_REPORTED_ONLY');
    expect(switched.length).toBeGreaterThan(0);
    expect(reportedOnly.length).toBeGreaterThan(0);

    // The registry: the CapabilityId union in the shared health contract.
    const health = read('project/shared/src/health.ts');
    const union = health.slice(
      health.indexOf('export type CapabilityId ='),
      health.indexOf('export type CapabilityState'),
    );
    const registry = [...union.matchAll(/^\s*\|\s*'([a-z-]+)'/gm)].map((m) => m[1]!);
    expect(registry.length).toBeGreaterThan(5);

    const scriptSet = [...switched, ...reportedOnly].sort();
    // A capability in neither list is F15 exactly: an operator sees it in
    // health, does not see it here, and concludes something is broken.
    const missing = registry.filter((id) => !scriptSet.includes(id));
    expect(
      missing,
      `capabilities the operator script does not know: ${missing.join(', ')}. ` +
        `Add each to FEATURE_IDS (this script switches it) or to ` +
        `FEATURE_IDS_REPORTED_ONLY plus feature_decided_by (it is decided elsewhere).`,
    ).toEqual([]);
    // And the other direction: a list entry the registry no longer reports is a
    // toggle for something that is not there.
    const stale = scriptSet.filter((id) => !registry.includes(id));
    expect(
      stale,
      `the operator script lists capabilities the registry does not report: ${stale.join(', ')}`,
    ).toEqual([]);
    // No id may be in both lists: switched and decided-elsewhere are exclusive.
    expect(new Set(scriptSet).size, 'a capability id appears in both lists').toBe(scriptSet.length);
    // Every reported-only id says where it IS decided, or it reads as broken.
    for (const id of reportedOnly) {
      const decided = helper(`feature_decided_by ${id}`).out;
      expect(decided, `feature_decided_by says nothing for ${id}`).not.toBe('');
    }
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

/**
 * A half-finished upgrade must be RESUMABLE, and the recorded version must
 * never run ahead of the work it records.
 *
 * Observed on a customer instance at v1.7.3: `compose pull` failed, and because
 * `env_set COGETO_VERSION "$target"` ran BEFORE the pull, `.env` claimed the new
 * version while 1.7.2 containers kept serving. The next `cogeto upgrade 1.7.3`
 * compared the target against that claim and answered "already on v1.7.3 —
 * nothing to do", so the retry path was closed by the failure itself. A failed
 * upgrade was indistinguishable from a finished one, which is the F1/F2
 * "tooling that lies" class, in the one subcommand the smoke harness states it
 * cannot exercise.
 */
describe('operator script — a failed upgrade is resumable and never lies about the version', () => {
  const script = readFileSync(SCRIPT, 'utf8');
  const upgrade = script.slice(
    script.indexOf('cmd_upgrade() {'),
    script.indexOf('# After an upgrade the configured embedding model'),
  );

  it('the version is recorded only after the containers actually run it', () => {
    const pull = upgrade.indexOf('compose pull --quiet');
    const up = upgrade.indexOf('compose up -d --remove-orphans');
    // The one write before the pull is the correction inside the "already on"
    // branch, which mutates nothing but the file and only to make it agree with
    // the containers; it is identified by the early return that follows it.
    const earlyReturn = upgrade.indexOf('    print_checklist\n    return 0');
    const writes = [...upgrade.matchAll(/env_set COGETO_VERSION "\$target"/g)].map((m) => m.index!);
    expect(pull).toBeGreaterThan(-1);
    expect(up).toBeGreaterThan(-1);
    expect(writes.length, 'the upgrade path does not record the version at all').toBeGreaterThan(0);
    // The whole defect in one assertion: no write happens between deciding to
    // upgrade and the containers actually running the target.
    const premature = writes.filter((at) => at > earlyReturn && at < up);
    expect(
      premature,
      'the upgrade records the new version before the containers run it, which is what made a failed upgrade look finished',
    ).toEqual([]);
    expect(writes.some((at) => at > pull && at > up)).toBe(true);
    // The pull and the up still see the target, through the exported value
    // rather than through a premature write to .env.
    expect(upgrade).toContain('export COGETO_VERSION');
  });

  it('"nothing to do" is decided by the RUNNING image, not by the file', () => {
    expect(upgrade).toContain('running="$(running_app_version)"');
    expect(upgrade).toMatch(/if \[ "\$running" = "\$target" \]; then/);
    expect(script).toContain("docker inspect -f '{{.Config.Image}}'");
  });

  it('a recorded version that disagrees with the running one is announced and resumed', () => {
    expect(upgrade).toContain('INCONSISTENT');
    expect(upgrade).toContain('Going by what is RUNNING');
    expect(upgrade).toContain('resume upgrade to ${target}');
  });

  it('a failed pull, a failed signature check and a failed start each say what happened', () => {
    // `set -e` used to abort each of these with no message of its own, which
    // reads to an operator as "it just died".
    expect(upgrade).toContain('PULLING THE v${target} IMAGES FAILED');
    expect(upgrade).toContain('sudo docker login');
    expect(upgrade).toContain('STARTING THE v${target} STACK FAILED');
    expect(script).toContain('SIGNATURE VERIFICATION FAILED');
    // And each names the way back, which is the same command they just ran.
    expect(upgrade).toContain("re-run 'sudo cogeto upgrade ${target}'");
  });

  it('image cleanup keeps the current and the previous version, and nothing else Cogeto-published', () => {
    const host = [
      'cogeto/cogeto:1.7.3',
      'cogeto/cogeto-edge:1.7.3',
      'cogeto/cogeto-mail:1.7.3',
      'cogeto/cogeto:1.7.2',
      'cogeto/cogeto-edge:1.7.2',
      'cogeto/cogeto:1.7.1',
      'cogeto/cogeto-redaction:1.6.0',
      'cogeto/cogeto:latest',
      // Infra: digest-pinned, shared, and a re-pull is exactly the Docker Hub
      // budget an upgrade cannot afford. Never a candidate.
      'postgres:17',
      'qdrant/qdrant:v1.12.4',
      'minio/minio:latest',
      'ghcr.io/zitadel/zitadel:v2',
      'searxng/searxng:2026.7.19',
      '<none>:<none>',
    ].join('\\n');
    const { out } = helper(`printf '${host}\\n' | prunable_image_tags 1.7.3 1.7.2`);
    expect(out.split('\n').filter(Boolean).sort()).toEqual([
      'cogeto/cogeto-redaction:1.6.0',
      'cogeto/cogeto:1.7.1',
      'cogeto/cogeto:latest',
    ]);
  });

  it('the cleanup never forces a removal, and runs only after the new version is up', () => {
    // Not forced: `docker rmi` refuses an image a container still references,
    // and that refusal is the safety property. A `-f` here could pull the floor
    // out from under a running container.
    expect(script).toContain('docker rmi "$poi_ref"');
    expect(script).toContain('[dry-run] would remove');
    expect(script).not.toMatch(/docker rmi\s+-f/);
    expect(script).not.toContain('docker system prune');
    expect(script).not.toContain('docker image prune');
    const up = upgrade.indexOf('compose up -d --remove-orphans');
    const prune = upgrade.indexOf('prune_old_images "$target" "$current"');
    expect(prune).toBeGreaterThan(up);
    // And it keeps the version the rollback line offers, so that rollback needs
    // no network.
    expect(upgrade).toContain("'cogeto upgrade ${current}'");
  });

  it('an instance with no app container is reported as such, not as healthy', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cogeto-operator-resume-'));
    writeFileSync(path.join(root, '.env'), 'COGETO_VERSION=9.9.9\n', { mode: 0o600 });
    const { status, out } = runScript(['upgrade', '9.9.9', '--check', '--root', root]);
    rmSync(root, { recursive: true, force: true });
    expect(status).toBe(0);
    expect(out).toContain('NOTHING IS RUNNING');
    expect(out).toContain('docker compose up -d');
  });
});

/**
 * The operator-supplied certificate override (issue #600, verification N2).
 *
 * `docs/operations/email-inbound.md` tells an operator with their own CA to
 * supply `cert.pem` and `key.pem` themselves. The recorded way to say so used
 * to be "leave COGETO_MAIL_TLS_SITE empty", which `sync_mail_tls_site` then
 * undid on the next upgrade, on both mail transitions and on a domain change:
 * the instance silently went back to ordering a certificate, and the sidecar
 * overwrote the operator's material with it. The intention is now a recorded
 * value, and these are the four paths that used to lose it.
 */
describe('operator script — inbound-mail TLS: the operator-supplied override survives', () => {
  const OPERATOR_ENV =
    'COGETO_VERSION=9.9.9\n' +
    'COGETO_EXTERNAL_DOMAIN=acme.cogeto.eu\n' +
    'COMPOSE_PROFILES=mail\n' +
    'COGETO_MAIL_ENABLED=1\n' +
    'COGETO_MAIL_TLS_MODE=operator\n' +
    'COGETO_MAIL_TLS_SITE=\n';

  const AUTOMATIC_ENV =
    'COGETO_VERSION=9.9.9\n' +
    'COGETO_EXTERNAL_DOMAIN=acme.cogeto.eu\n' +
    'COMPOSE_PROFILES=mail\n' +
    'COGETO_MAIL_ENABLED=1\n';

  const withEnv = (env: string): string => {
    const root = mkdtempSync(path.join(tmpdir(), 'cogeto-operator-mailtls-'));
    writeFileSync(path.join(root, '.env'), env, { mode: 0o600 });
    return root;
  };

  /** Run the real convergence function against a real .env, as upgrade does. */
  const converge = (env: string): string => {
    const root = withEnv(env);
    const envFile = path.join(root, '.env');
    spawnSync(
      'bash',
      ['-c', `source '${SCRIPT}'; CHECK=0; ENV_FILE='${envFile}'; sync_mail_tls_site`],
      { encoding: 'utf8', timeout: 30_000 },
    );
    const after = readFileSync(envFile, 'utf8');
    rmSync(root, { recursive: true, force: true });
    return after;
  };

  it('the upgrade path (the convergence itself) leaves an operator-supplied configuration alone', () => {
    // What `cogeto upgrade` does to this configuration is exactly this call.
    expect(converge(OPERATOR_ENV)).toBe(OPERATOR_ENV);
    // Even if a site value is somehow present (a hand-edited file, an older
    // instance), the recorded mode wins: an upgrade must never be the thing
    // that puts an instance back on the edge's certificate authority.
    const handEdited =
      'COGETO_VERSION=9.9.9\n' +
      'COGETO_EXTERNAL_DOMAIN=acme.cogeto.eu\n' +
      'COMPOSE_PROFILES=mail\n' +
      'COGETO_MAIL_ENABLED=1\n' +
      'COGETO_MAIL_TLS_MODE=operator\n' +
      'COGETO_MAIL_TLS_SITE=mail.legacy.cogeto.eu\n';
    expect(converge(handEdited)).toBe(handEdited);
  });

  it('an automatic configuration still converges exactly as it did', () => {
    expect(converge(AUTOMATIC_ENV)).toContain('COGETO_MAIL_TLS_SITE=mail.acme.cogeto.eu');
    // Mail off: the site is blanked, so the edge's ACME vhost goes inert.
    const off = 'COGETO_VERSION=9.9.9\nCOGETO_EXTERNAL_DOMAIN=acme.cogeto.eu\n';
    expect(converge(off)).toContain('COGETO_MAIL_TLS_SITE=\n');
  });

  it('enabling and disabling mail leave an operator-supplied configuration alone', () => {
    for (const verb of ['enable', 'disable']) {
      const root = withEnv(OPERATOR_ENV);
      const { out } = runScript(['features', verb, 'mail', '--check', '--root', root]);
      const after = readFileSync(path.join(root, '.env'), 'utf8');
      rmSync(root, { recursive: true, force: true });
      expect(out, `features ${verb} mail rewrites the site`).not.toContain(
        'would set COGETO_MAIL_TLS_SITE',
      );
      expect(out).toContain('operator-supplied');
      expect(after).toBe(OPERATOR_ENV); // --check mutates nothing either way
    }
  });

  it('a domain change leaves an operator-supplied configuration alone', () => {
    const root = withEnv(OPERATOR_ENV);
    const { out } = runScript([
      'configure',
      '--domain',
      'newname.cogeto.eu',
      '--check',
      '--root',
      root,
    ]);
    rmSync(root, { recursive: true, force: true });
    // The domain itself still moves...
    expect(out).toContain('would set COGETO_EXTERNAL_DOMAIN');
    // ...and the certificate the operator owns does not follow it.
    expect(out).not.toContain('would set COGETO_MAIL_TLS_SITE');
    expect(out).toContain('operator-supplied');
  });

  it('an automatic instance still has all four paths converge it', () => {
    // The other direction of the same guard: the fix must not have turned the
    // convergence off for everyone. Every call site is enumerated here, so a
    // fifth path that skips the chokepoint is visible in review.
    const script = readFileSync(SCRIPT, 'utf8');
    const callers = ['cmd_upgrade', 'features_enable', 'features_disable', 'cmd_configure'];
    for (const caller of callers) {
      const start = script.indexOf(`${caller}() {`);
      expect(start, `${caller} is gone`).toBeGreaterThan(-1);
      const body = script.slice(start, start + 12_000);
      expect(body, `${caller} no longer converges the mail TLS site`).toContain(
        'sync_mail_tls_site',
      );
    }
    // ...and the chokepoint is the ONLY writer of the site variable outside the
    // deliberate override, so honouring the mode in one place is enough.
    const writers = [...script.matchAll(/env_set COGETO_MAIL_TLS_SITE/g)].length;
    expect(
      writers,
      'COGETO_MAIL_TLS_SITE is written outside sync_mail_tls_site and the override',
    ).toBe(3);
  });

  it('configure records the intent, states the consequence, and asks before undoing it', () => {
    const root = withEnv(AUTOMATIC_ENV);
    const toOperator = runScript([
      'configure',
      '--mail-tls-mode',
      'operator',
      '--check',
      '--root',
      root,
    ]);
    expect(toOperator.status).toBe(0);
    expect(toOperator.out).toContain('would set COGETO_MAIL_TLS_MODE');
    expect(toOperator.out).toContain('would set COGETO_MAIL_TLS_SITE');
    expect(toOperator.out).toContain('RENEWAL IS NOW YOURS');
    rmSync(root, { recursive: true, force: true });

    // Going back is deliberate: a typed confirmation naming what it overwrites.
    const back = withEnv(OPERATOR_ENV);
    const toAutomatic = runScript([
      'configure',
      '--mail-tls-mode',
      'automatic',
      '--check',
      '--root',
      back,
    ]);
    rmSync(back, { recursive: true, force: true });
    expect(toAutomatic.status).toBe(0);
    expect(toAutomatic.out).toContain("would ask you to type 'hand mail TLS back to the edge'");
    expect(toAutomatic.out).toContain('OVERWRITES');

    const bad = withEnv(AUTOMATIC_ENV);
    const rejected = runScript([
      'configure',
      '--mail-tls-mode',
      'sometimes',
      '--check',
      '--root',
      bad,
    ]);
    rmSync(bad, { recursive: true, force: true });
    expect(rejected.status).toBe(1);
    expect(rejected.out).toContain('valid: automatic');
  });

  it('configure with no arguments prints which mode the instance is in', () => {
    const operatorRoot = withEnv(OPERATOR_ENV);
    const operatorOut = runScript(['configure', '--check', '--root', operatorRoot]).out;
    rmSync(operatorRoot, { recursive: true, force: true });
    expect(operatorOut).toContain('inbound mail TLS   = operator-supplied');

    const autoRoot = withEnv(AUTOMATIC_ENV);
    const autoOut = runScript(['configure', '--check', '--root', autoRoot]).out;
    rmSync(autoRoot, { recursive: true, force: true });
    expect(autoOut).toContain('inbound mail TLS   = automatic');
  });

  it('the synchroniser refuses to touch the volume in operator-supplied mode', () => {
    // The sidecar honours the recorded mode itself, not merely the empty site:
    // overwriting an operator's certificate moves their instance off their own
    // CA, so the mode is checked before anything is read or copied.
    const sync = read('project/infra/docker/caddy/mail-tls-sync.sh');
    const guard = sync.indexOf('if [ "$TLS_MODE" = "operator" ]; then');
    expect(guard, 'the sync loop does not check the mode').toBeGreaterThan(-1);
    expect(guard).toBeLessThan(sync.indexOf('while :; do\n  src_cert='));
    expect(sync).toContain('COGETO_MAIL_TLS_MODE:-automatic');
    // Proved by running it: with the mode set, the loop announces and idles,
    // and the destination directory stays empty.
    const dest = mkdtempSync(path.join(tmpdir(), 'cogeto-mail-tls-dest-'));
    const store = mkdtempSync(path.join(tmpdir(), 'cogeto-caddy-data-'));
    const certDir = path.join(store, 'caddy', 'certificates', 'issuer', 'mail.acme.cogeto.eu');
    spawnSync('mkdir', ['-p', certDir]);
    writeFileSync(path.join(certDir, 'mail.acme.cogeto.eu.crt'), 'EDGE CERT\n');
    writeFileSync(path.join(certDir, 'mail.acme.cogeto.eu.key'), 'EDGE KEY\n');
    writeFileSync(path.join(dest, 'cert.pem'), 'OPERATOR CERT\n');
    writeFileSync(path.join(dest, 'key.pem'), 'OPERATOR KEY\n');
    const r = spawnSync(
      'bash',
      [
        '-c',
        `COGETO_MAIL_TLS_MODE=operator COGETO_MAIL_TLS_SITE=mail.acme.cogeto.eu ` +
          `COGETO_CADDY_DATA_DIR='${store}' COGETO_MAIL_TLS_DIR='${dest}' ` +
          `COGETO_MAIL_TLS_SYNC_INTERVAL_SECONDS=1 ` +
          // The loop idles forever by design, so it is backgrounded and killed
          // rather than timed out (`timeout` is not on a macOS box).
          `sh '${path.join(REPO, 'project/infra/docker/caddy/mail-tls-sync.sh')}' & ` +
          `pid=$!; sleep 3; kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; true`,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    const cert = readFileSync(path.join(dest, 'cert.pem'), 'utf8');
    const key = readFileSync(path.join(dest, 'key.pem'), 'utf8');
    rmSync(dest, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
    expect(r.stdout).toContain('COGETO_MAIL_TLS_MODE=operator');
    expect(cert, "the sidecar overwrote the operator's certificate").toBe('OPERATOR CERT\n');
    expect(key, "the sidecar overwrote the operator's key").toBe('OPERATOR KEY\n');
  });

  it('the mode reaches the sidecar on the stack customers run', () => {
    const deploy = read('project/infra/deploy/docker-compose.deploy.yml');
    const sidecar = deploy.slice(deploy.indexOf('\n  mail-tls-sync:\n'));
    expect(sidecar.slice(0, sidecar.indexOf('\n\n'))).toContain(
      'COGETO_MAIL_TLS_MODE: ${COGETO_MAIL_TLS_MODE:-automatic}',
    );
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
    // THREE optional profiles in the deploy channel: `research` (SearXNG, a
    // digest-pinned upstream image, still pull-only), `mail` (SEC-14: inbound
    // SMTP is opt-in) and `redaction` (issue #565). The dev-only profiles
    // (demo, dev-seed, consoles), whose images are never published, stay
    // absent. Asserted as a SET because more than one service may ride one
    // profile: mail-tls-sync rides `mail`.
    const profiles = new Set(
      [...deploy.matchAll(/profiles:\s*\[([^\]]*)\]/g)].map((m) => m[1]!.trim()),
    );
    expect(profiles).toEqual(new Set(["'research'", "'mail'", "'redaction'"]));
    expect(deploy).not.toContain('demo-seed');
    expect(deploy).not.toContain('seed-object');
    expect(deploy).not.toContain('caddy-consoles');
  });

  /**
   * Redaction on the deployed path (issue #565).
   *
   * This block REPLACES the assertions that pinned the opposite decision: that
   * the deploy compose's profile list was exactly two entries and that no
   * `redaction:` service block might appear. That decision was deliberate
   * while the sidecar's image was unpublished — a pull-only instance cannot
   * build one — and it is now reversed, so the invariants are rewritten to
   * encode the new intent rather than deleted. What must stay true is that the
   * capability is really reachable and really contained.
   */
  /** One service's YAML block: its key line up to the following blank line. */
  const block = (compose: string, name: string): string => {
    const start = compose.indexOf(`\n  ${name}:\n`);
    if (start < 0) return '';
    const end = compose.indexOf('\n\n', start + 1);
    return end < 0 ? compose.slice(start) : compose.slice(start, end);
  };

  describe('redaction is reachable on a customer instance, and contained', () => {
    const redactionBlock = block(deploy, 'redaction');

    it('the profile exists and carries a pull-only, digest-versioned sidecar', () => {
      expect(redactionBlock, 'no redaction service in the deploy compose').not.toBe('');
      expect(redactionBlock).toMatch(/profiles:\s*\['redaction'\]/);
      expect(redactionBlock).toMatch(/image: cogeto\/cogeto-redaction:\$\{COGETO_VERSION/);
      // Pull-only is the whole reason this was blocked before: no build key.
      expect(redactionBlock).not.toMatch(/build:/);
    });

    it('the sidecar is internal-only — no published port, and the edge never proxies it', () => {
      // It holds the plaintext of everything on its way to a model. Nothing
      // outside the compose network may reach it.
      expect(redactionBlock).not.toContain('ports:');
      expect(deployCaddy).not.toContain('redaction');
    });

    it('it carries the healthcheck the dev definition uses, so `unreachable` is real', () => {
      // Fail-closed only means something if the gateway can tell. The dev
      // healthcheck loads the model, so a sidecar that cannot load it reports
      // unhealthy rather than accepting requests it will fail.
      expect(redactionBlock).toContain("urlopen('http://127.0.0.1:8080/health')");
      expect(redactionBlock).toContain('start_period: 90s');
    });

    it('the three REDACTION_* variables reach BOTH the app and the worker', () => {
      // The defect this closes: neither root received them, so setting them by
      // hand in a customer's .env had no effect whatsoever. They live in the
      // shared `&cogeto-env` anchor, which the worker merges with `<<:`.
      const anchor = deploy.slice(deploy.indexOf('environment: &cogeto-env'));
      for (const name of ['REDACTION_ENABLED', 'REDACTION_URL', 'REDACTION_REQUIRED']) {
        expect(anchor, `${name} is not in the shared environment anchor`).toContain(`${name}:`);
      }
      expect(deploy).toMatch(/worker:[\s\S]*?<<: \*cogeto-env/);
    });

    it('the release pipeline publishes, signs and attests the sidecar image', () => {
      // A profile pointing at an image nobody publishes is the previous bug
      // with extra steps.
      expect(release).toContain('cogeto/cogeto-redaction');
      expect(release).toContain('context: project/services/redaction');
      expect(release).toContain('cosign sign --yes "${IMAGE_REDACTION}@${DIGEST_REDACTION}"');
      expect(release).toContain('"${IMAGE_REDACTION}@${DIGEST_REDACTION}"');
      expect(release).toMatch(/cosign attest[\s\S]*?IMAGE_REDACTION/);
      expect(release.match(/cosign sign --yes/g)?.length).toBeGreaterThanOrEqual(4);
    });

    it('the operator script no longer refuses the capability with the obsolete reason', () => {
      const script = readFileSync(SCRIPT, 'utf8');
      expect(script).not.toContain('its image is built from source, never published');
      expect(script).toContain('IMAGE_REDACTION="cogeto/cogeto-redaction"');
      // Enabling pulls and VERIFIES the image like every other release image.
      const enable = script.slice(
        script.indexOf('    redaction)'),
        script.indexOf('    demo)\n      # The production guard'),
      );
      expect(enable).toContain('compose --profile redaction pull');
      expect(enable).toContain('verify_images');
      // The operator is told the footprint before it lands on their instance.
      expect(enable).toMatch(/0\.7-1 GB RSS/);
    });
  });

  /**
   * Automatic inbound-mail TLS (issue #566). The consuming half always worked;
   * the producing half did not exist, so the certificate the runbook told
   * operators to copy was never issued.
   */
  describe('inbound mail TLS is obtained and propagated without an operator', () => {
    it('the edge has an ACME-only vhost for the mail hostname, inert when mail is off', () => {
      expect(deployCaddy).toContain('{$COGETO_MAIL_TLS_SITE:');
      // Nothing is served there: the mail host runs SMTP, not a web surface.
      const vhost = deployCaddy.slice(deployCaddy.indexOf('{$COGETO_MAIL_TLS_SITE:'));
      expect(vhost).toContain('respond 404');
      expect(vhost).not.toContain('reverse_proxy');
      // The fallback must disable automatic HTTPS (explicit http:// scheme)
      // and name a hostname that can never resolve, or an instance without
      // email capture would order a certificate it can never obtain.
      //
      // It is substituted BY COMPOSE, not by Caddy: Caddy applies a
      // `{$VAR:default}` only when the variable is UNSET, and compose always
      // sets this one, so an empty value reaches Caddy as an empty site
      // address and crash-loops the edge (observed, then fixed). The Caddyfile
      // keeps the same literal as a defensive default for a run without
      // compose; the two must not drift apart.
      const composeFallback = deploy.match(
        /COGETO_MAIL_TLS_SITE: \$\{COGETO_MAIL_TLS_SITE:-(http:\/\/[\w.-]+\.invalid)\}/,
      )?.[1];
      expect(composeFallback, 'the deploy compose has no inert fallback site address').toBeTruthy();
      const caddyFallback = deployCaddy.match(
        /\{\$COGETO_MAIL_TLS_SITE:(http:\/\/[\w.-]+\.invalid)\}/,
      )?.[1];
      expect(caddyFallback, 'the Caddyfile has no defensive fallback site address').toBe(
        composeFallback,
      );
    });

    it('the site variable is derived by the script, from the SAME derivation as the DNS record', () => {
      const script = readFileSync(SCRIPT, 'utf8');
      expect(script).toContain('sync_mail_tls_site');
      const sync = script.slice(
        script.indexOf('sync_mail_tls_site() {'),
        script.indexOf('# ── Health wait'),
      );
      expect(sync).toContain('derive_mx_host');
      expect(sync).toContain('env_set COGETO_MAIL_TLS_SITE');
      // Enabling and disabling mail, and moving the domain, all converge it.
      expect(script.match(/sync_mail_tls_site$/gm)?.length).toBeGreaterThanOrEqual(4);
      expect(deploy).toContain('COGETO_MAIL_TLS_SITE: ${COGETO_MAIL_TLS_SITE:-}');
    });

    it('propagation is automatic, profile-gated, and keeps the dedicated-volume boundary', () => {
      const sync = block(deploy, 'mail-tls-sync');
      expect(sync, 'no mail-tls-sync service in the deploy compose').not.toBe('');
      expect(sync).toMatch(/profiles:\s*\['mail'\]/);
      // It reads the certificate store READ-ONLY and publishes two files on.
      expect(sync).toContain('caddy-data:/data:ro');
      expect(sync).toContain('mail-tls:/mail-tls');
      // The boundary that made this a sidecar rather than a mount: the
      // internet-facing mail container must never see caddy-data.
      const mail = block(deploy, 'mail');
      expect(mail).toContain('mail-tls:/app/tls:ro');
      // The volumes list only — the ports list has the same list shape.
      const mailVolumes = mail.slice(mail.indexOf('\n    volumes:'), mail.indexOf('\n    ports:'));
      const mailMounts = mailVolumes.split('\n').filter((l) => /^\s+- \S+:/.test(l));
      expect(mailMounts, 'the mail container mounts more than its own TLS volume').toEqual([
        '      - mail-tls:/app/tls:ro',
      ]);
      // No Docker socket anywhere: restarting the mail service is the mail
      // service's own job, and a socket here would be root on the host.
      expect(deploy).not.toContain('/var/run/docker.sock');
    });

    it('the propagated material is readable by the mail container’s non-root user', () => {
      // The silent trap: a root-only mode is indistinguishable, to the
      // entrypoint's readability test, from no certificate at all.
      const script = read('project/infra/docker/caddy/mail-tls-sync.sh');
      expect(script).toContain('chown "$MAIL_UID:$MAIL_GID"');
      expect(script).toContain('MAIL_UID="${COGETO_MAIL_UID:-1000}"');
      // And it copies only when the material CHANGED, so a steady state
      // restarts nothing.
      expect(script).toContain('if [ "$src_hash" != "$dst_hash" ]; then');
      // Baked into the published edge image, so it survives an upgrade the
      // same way the compose file does.
      expect(read('project/infra/docker/Dockerfile')).toContain(
        'COPY project/infra/docker/caddy/mail-tls-sync.sh /usr/local/bin/cogeto-mail-tls-sync',
      );
    });

    it('the mail image can actually serve TLS: Haraka needs openssl for dhparams', () => {
      // Found by bringing the deploy stack up with a real certificate for the
      // first time. Haraka's `tls` plugin generates a Diffie-Hellman parameter
      // file by spawning `openssl dhparam`, and the base image has none, so the
      // plugin died at load with `spawn openssl ENOENT` and the mail container
      // crash-looped the moment a certificate appeared. It was invisible for as
      // long as no certificate ever did: the consuming half of inbound TLS was
      // never exercised end to end. Both halves of the fix are pinned here.
      const mailDockerfile = read('project/services/mail/Dockerfile');
      expect(mailDockerfile).toMatch(/apk add --no-cache openssl/);
      const entrypoint = read('project/services/mail/docker-entrypoint.sh');
      // Generated by the entrypoint, not by Haraka: bounded and logged rather
      // than racing the plugin's 30-second spawn timeout, and named in tls.ini
      // so the plugin's own generator never runs.
      expect(entrypoint).toContain('openssl dhparam -out');
      expect(entrypoint).toContain('dhparam=dhparams.pem');
      // Per instance, not baked into the image: a shared DH group across every
      // deployment is exactly what makes precomputation worthwhile.
      expect(mailDockerfile).not.toContain('dhparam -out');
    });

    it('a renewal reaches the running listener without a human', () => {
      // Haraka reads the PEMs once at startup, so the entrypoint watches them
      // and exits on change; `restart: unless-stopped` brings it straight back
      // with the new certificate.
      const entrypoint = read('project/services/mail/docker-entrypoint.sh');
      expect(entrypoint).toContain('tls_fingerprint');
      expect(entrypoint).toContain('the TLS material changed');
      expect(entrypoint).toMatch(/trap '.*kill -TERM/);
      expect(block(deploy, 'mail')).toContain('restart: unless-stopped');
    });

    it('status reports whether STARTTLS is actually advertised and when the cert expires', () => {
      // The highest-value part: a cleartext downgrade used to be completely
      // silent. The check is the OBSERVABLE fact (an SMTP handshake), not the
      // presence of a file.
      const script = readFileSync(SCRIPT, 'utf8');
      const status = script.slice(
        script.indexOf('cmd_status() {'),
        script.indexOf('# ── features'),
      );
      expect(status).toContain('inbound mail TLS');
      expect(status).toContain('-starttls smtp');
      expect(status).toContain('-enddate');
      expect(status).toContain('CLEARTEXT');
    });
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
