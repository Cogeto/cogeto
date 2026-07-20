import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Session O6 — the operator script and the pull-only deploy channel
 * (decision 0030). Three groups:
 *
 *   1. The script's CLI contract: --help, argument validation, and the --check
 *      dry run (validates prerequisites, prints intended actions and the
 *      checklist, mutates NOTHING) — exercisable in CI on any machine.
 *   2. The pure helpers (secret formats, inbound-address derivation, version
 *      comparison), unit-tested by sourcing the script.
 *   3. Static hardening assertions over the deploy channel files, mirroring
 *      deployment-hardening.spec.ts: the customer stack never builds, keeps
 *      infra digest-pinned (QS-25), requires secrets, and carries no demo.
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

  it('install refuses retired (pre-release-flagged) releases — decision 0033', () => {
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

  it('upgrade self-heals the PATH install (issue #60: a re-downloaded script run via `upgrade` must still yield a working `sudo cogeto`)', () => {
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

  it('resolves the latest release and surfaces the version confirmation (decision 0033)', () => {
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
    // Real values, not placeholders (decision 0028 addressing scheme).
    expect(out).toContain('acme.cogeto.eu.  IN A');
    expect(out).toContain('in.acme.cogeto.eu.  IN MX 10  mail.acme.cogeto.eu.');
    expect(out).toContain('capture@in.acme.cogeto.eu');
    expect(out).toContain('PTR');
    expect(out).toContain('Automated Backup');
    // Grouped by immediacy, checkbox-style.
    expect(out).toContain('Do now:');
    expect(out).toContain('Verify after DNS propagates:');
    expect(out).toContain('[ ]');
  });

  it('checklist items carry the HOW (o6-dry-run detail pass)', () => {
    // DNS propagation + automatic ACME retry, right next to the records.
    expect(out).toContain('propagation takes minutes');
    expect(out).toContain('AUTOMATICALLY');
    // The PTR's exact panel path.
    expect(out).toContain('Edit the reverse');
    // Create-user guidance: console URL, initial password, the no-SMTP trap.
    expect(out).toContain('/ui/console');
    expect(out).toContain('Set initial password');
    expect(out).toContain('no outbound SMTP');
    // Sender-routed email test instructions (decision 0031).
    expect(out).toContain('FROM THEIR OWN ADDRESS');
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

  it('carries no version constants — GitHub release flags are the policy (decision 0033)', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).not.toContain('DEFAULT_VERSION');
    expect(script).not.toContain('MIN_VERSION');
    expect(script).toContain('GH_RELEASES_API');
    expect(script).toContain('require_supported_version');
  });

  it('derives the per-tenant addressing scheme (decision 0028 ruling 1)', () => {
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
  });
});

describe('deploy channel — hardening assertions (decision 0030)', () => {
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

  it('infra images stay pinned by digest (QS-25), same digests as the dev stack', () => {
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
    expect(deploy).not.toMatch(/profiles:/);
    expect(deploy).not.toContain('demo-seed');
    expect(deploy).not.toContain('seed-object');
  });

  it('Qdrant API-key auth is always on in the deploy stack (QS-4)', () => {
    expect(deploy).toMatch(/QDRANT__SERVICE__API_KEY: \$\{COGETO_QDRANT_API_KEY/);
  });

  it('the mail service maps standard inbound SMTP to the non-root listener', () => {
    expect(deploy).toContain(":-25}:2525'");
  });

  it('the production Caddyfile serves the real domain with ACME, not local_certs', () => {
    expect(deployCaddy).toContain('{$COGETO_EXTERNAL_DOMAIN}');
    expect(deployCaddy).toContain('email {$COGETO_ACME_EMAIL}');
    expect(deployCaddy).not.toContain('local_certs');
    // The presign origin (§A.9) rides the same edge.
    expect(deployCaddy).toContain('s3.{$COGETO_EXTERNAL_DOMAIN}');
  });

  it('the production edge keeps the dev CSP verbatim (QS-19 — no drift)', () => {
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
