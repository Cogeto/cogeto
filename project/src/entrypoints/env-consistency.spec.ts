import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * env_consistency (closes gap-audit 2.10/5.3; widened by issue #568): every
 * environment variable any SHIPPED code reads is documented where an operator
 * can find it, every documented variable is actually used, and every knob the
 * dev stack turns is also reachable on the stack customers run.
 *
 * WHY IT WAS WIDENED. The check reported "in sync" while three real defects
 * were true (deployment-readiness F5, F6, F7), because it could not see them:
 *
 *   1. It walked `project/src` only, so the mail service, the redaction
 *      sidecar, the SPA, `scripts/` and the Zitadel bootstrap were invisible.
 *   2. It matched only `env.NAME`, so `provider-config.ts`'s whole family of
 *      `read(env, 'NAME')` / `readTimeoutMs(env, 'NAME', …)` reads was unseen.
 *   3. It recognised only the `COGETO_` prefix, so REDACTION_*, ZITADEL_*,
 *      POSTGRES_*, MINIO_* and SEARXNG_SECRET could not be checked at all.
 *
 * The redaction variables sat inside all three blind spots at once, which is
 * precisely why "documented as available, absent from the deploy compose"
 * survived every green CI run.
 *
 * And the rule that would have caught the class rather than the instances:
 * a variable READ BY CODE and PASSED BY THE DEV COMPOSE must also be passed by
 * the DEPLOY compose, unless the difference is deliberate and written down.
 * Without it the two files drift again on the next feature.
 *
 * Pure file reads; no container needed.
 */

// Vitest runs from project/src; the repo root is two levels up.
const SRC = process.cwd();
const REPO = path.resolve(SRC, '../..');

/**
 * Every tree that ships or operates the product. `project/src` is the
 * application; everything else here was outside the walk and is where the
 * blind spots lived.
 */
const CODE_ROOTS = [
  'project/src', // the application (TypeScript)
  'project/web/src', // the SPA
  'project/services/mail', // the Haraka image: entrypoint + plugins
  'project/services/redaction', // the PII sidecar (Python)
  'project/infra/docker/zitadel-init', // the identity bootstrap one-shot
  'scripts', // the operator script and the CI/dev tooling
];

/** Extensions worth scanning in those trees. */
const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.sh'];

/**
 * Every prefix in use. Recognising only `COGETO_` is what made the redaction
 * family unrepresentable to this check.
 */
const PREFIXES = [
  'COGETO_',
  'REDACTION_',
  'ZITADEL_',
  'POSTGRES_',
  'MINIO_',
  'SEARXNG_',
  'SPACY_',
  'COMPOSE_PROFILES',
];

const isTracked = (name: string): boolean => PREFIXES.some((prefix) => name.startsWith(prefix));

/**
 * The read forms that actually appear in this repository. Each one exists
 * because some real call site uses it:
 *
 *   env.NAME / process.env.NAME        the common TypeScript form
 *   env['NAME'] / process.env["NAME"]  the indexed form
 *   read(env, 'NAME')                  provider-config.ts's accessor family
 *   { env: 'NAME' }                    secret-preflight.ts's declarative list
 *   os.environ.get("NAME") / getenv    the Python sidecar
 *   $NAME / ${NAME:-default}           shell entrypoints and the operator script
 */
const READ_PATTERNS: readonly RegExp[] = [
  /(?:process\.)?env\.([A-Z][A-Z0-9_]*)/g,
  /(?:process\.)?env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
  /\benv\s*,\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
  /\benv\s*:\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
  /os\.environ(?:\.get)?[[(]\s*["']([A-Z][A-Z0-9_]*)["']/g,
  /os\.getenv\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
  /\$\{?([A-Z][A-Z0-9_]*)[}:\s]/g,
];

/** Dev/CI-only toggles set by npm scripts, seed tooling or dev utilities. */
const DEV_ONLY = new Set([
  'COGETO_EVAL_GATE',
  // Harness-only: off | record | replay for the cached pull-request eval job
  // (docs/eval-golden-set.md §6). Never read by a running instance.
  'COGETO_EVAL_CACHE',
  'COGETO_SEED_ORG',
  'COGETO_SEED_OWNER',
  // Test-only: vitest points the demo corpus loader at project/demo.
  'COGETO_DEMO_DIR',
  // scripts/dev/send-test-email.mjs only: where a developer's fixture send
  // should land. No shipped process reads them.
  'COGETO_MAIL_HOST',
  'COGETO_MAIL_PORT',
  // The operator script's own knobs, set by an operator on the command line,
  // never by the stack: the instance directory and the resource-check escape.
  'COGETO_ROOT',
  'COGETO_SKIP_RESOURCE_CHECK',
  // scripts/ci/operator-smoke.sh only (issue #593): a compose override staged
  // beside the smoke stack's deployment files so a developer can run the full
  // smoke on a machine where 80/443 are already taken. CI never sets it, no
  // shipped process reads it, and the harness says so when it is used.
  'COGETO_SMOKE_COMPOSE_OVERRIDE',
  // Read by the operator script when it inspects the instance's compose file
  // rather than configuring anything (the value comes from .env, which the
  // script itself wrote).
  'COGETO_VERSION',
]);

function walkCode(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '__pycache__', '.pytest_cache'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkCode(full, acc);
    } else if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.spec.tsx')) {
      continue;
    } else if (CODE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      acc.push(full);
    } else if (!entry.name.includes('.') && dir.endsWith('operator')) {
      // scripts/operator/cogeto — an extensionless bash script.
      acc.push(full);
    }
  }
  return acc;
}

function varsReadInCode(): Set<string> {
  const found = new Set<string>();
  for (const root of CODE_ROOTS) {
    const full = path.join(REPO, root);
    if (!existsSync(full)) continue;
    for (const file of walkCode(full)) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of READ_PATTERNS) {
        pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(text))) {
          if (isTracked(m[1]!)) found.add(m[1]!);
        }
      }
    }
  }
  return found;
}

/**
 * The variable names a file NAMES.
 *
 * `stripComments` is the difference between the two kinds of file this is used
 * on, and it is not cosmetic (issue #603). In a compose file a `#` line is
 * prose, so counting it made a variable that was DELETED from an `environment:`
 * block but still mentioned in the comment beside it satisfy the deploy-parity
 * rule while never reaching the process: F7's exact failure mode surviving the
 * check written to catch it. In `.env.example` a `#` line IS the entry (every
 * documented variable is commented out so the file is a reference, not a
 * configuration), so stripping there would erase the documentation itself.
 */
function varsIn(file: string, stripComments = false): Set<string> {
  const raw = readFileSync(path.join(REPO, file), 'utf8');
  const text = stripComments
    ? raw
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n')
    : raw;
  const found = new Set<string>();
  const re = /\b([A-Z][A-Z0-9_]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (isTracked(m[1]!)) found.add(m[1]!);
  }
  return found;
}

/**
 * The variables `.env.example` actually OFFERS: names on an entry line
 * (`NAME=`, commented out or not), as opposed to names its prose mentions.
 *
 * The distinction only started to matter once the compose files stopped
 * counting their own comments (issue #603). Two of the names this file mentions
 * are deliberately NOT settings — "do NOT set `MINIO_SERVER_URL`" and a note
 * that the `COGETO_OLLAMA_TIMEOUT_*_MS` alias was retired — and they were
 * passing the no-dead-entries rule by matching a comment in a compose file,
 * which is the same accident the strip removes. A sentence about a variable is
 * not an entry, and requiring it to be wired would mean deleting the warning.
 */
function entriesIn(file: string): Set<string> {
  const text = readFileSync(path.join(REPO, file), 'utf8');
  const found = new Set<string>();
  for (const line of text.split('\n')) {
    const m = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (m && isTracked(m[1]!)) found.add(m[1]!);
  }
  return found;
}

/** Read by the eval CLIs only, never by a running instance; documenting them
 * in .env.example is for the eval workflow, not the stacks. */
const EVAL_ONLY = new Set(['COGETO_MODEL_GRADER', 'COGETO_PROVIDER_GRADER']);

/**
 * The eval harness's OWN model-configuration surface
 * (`resolveEvalProvidersFromEnv`). Deliberately absent from `.env.example` and
 * from both compose files: the interface is the only place a running instance
 * configures models, and the harness is the sanctioned exception because it
 * runs in CI against no instance database. `model-config-env.spec.ts` is what
 * keeps them confined to the harness; this set is what stops the widened walk
 * from reading that confinement as missing documentation.
 * Their contract is documented in docs/eval-golden-set.md.
 */
const EVAL_HARNESS_MODEL_VARS = new Set([
  'COGETO_PROVIDER_PRESET',
  'COGETO_PROVIDER_PIPELINE',
  'COGETO_PROVIDER_ANSWER',
  'COGETO_PROVIDER_EMBEDDINGS',
  'COGETO_PROVIDER_VISION',
  'COGETO_MODEL_PIPELINE',
  'COGETO_MODEL_ANSWER',
  'COGETO_MODEL_EMBEDDINGS',
  'COGETO_MODEL_VISION',
  'COGETO_MISTRAL_API_KEY',
  'COGETO_MISTRAL_MODEL_PIPELINE',
  'COGETO_MISTRAL_MODEL_ANSWER',
  'COGETO_MISTRAL_EMBED_MODEL',
  'COGETO_OPENAI_API_KEY',
  'COGETO_OPENAI_BASE_URL',
  'COGETO_ANTHROPIC_API_KEY',
  'COGETO_ANTHROPIC_BASE_URL',
  'COGETO_OLLAMA_API_KEY',
  'COGETO_OLLAMA_BASE_URL',
]);

const isUndocumentedByDesign = (name: string): boolean =>
  DEV_ONLY.has(name) || EVAL_HARNESS_MODEL_VARS.has(name);

/**
 * The recorded exceptions to the deploy-parity rule below (issue #568). Every
 * entry is a variable the dev compose passes and the deploy compose
 * deliberately does not, with the reason. An exception is a decision on the
 * record, not a silence: adding one costs a line here that a reviewer reads.
 */
const DEPLOY_PARITY_EXCEPTIONS: Record<string, string> = {
  COGETO_DEMO_MODE: 'the demo profile is dev-only and a customer stack must not grow a demo switch',
  COGETO_DEMO_APP_URL: 'demo seed target; the demo profile does not exist in the deploy channel',
  COGETO_DEMO_RESET_CRON: 'demo-only: schedules the sandbox reset the deploy stack hard-refuses',
  COGETO_DEMO_SESSION_FILE: 'demo-only: the sandbox session the deploy stack never serves',
  COGETO_ZITADEL_PAT_FILE:
    'demo-seed only: the bootstrap PAT is revoked after install on a customer instance',
  MINIO_BROWSER_REDIRECT_URL:
    'the MinIO console rides the dev-only consoles profile; no console is exposed on a customer instance',
};

/**
 * The one prefix-level exception. Every `COGETO_DEMO_*` limit override belongs
 * to the public sandbox, which a customer instance hard-refuses
 * (COGETO_PRODUCTION=1), so listing eleven near-identical reasons would be
 * noise. A blanket exception is how F21 (a single demo variable that HAD
 * leaked into the customer compose) went unnoticed, so the escape is paired
 * with an assertion below that none of them is present: excused from the
 * parity rule, and separately forbidden outright.
 */
const DEPLOY_PARITY_EXCEPT_PREFIXES: Record<string, string> = {
  COGETO_DEMO_:
    'the demo profile is dev-only; a customer stack must not grow a demo switch, and its absence is asserted separately',
};

const hasDeployParityException = (name: string): boolean =>
  name in DEPLOY_PARITY_EXCEPTIONS ||
  Object.keys(DEPLOY_PARITY_EXCEPT_PREFIXES).some((prefix) => name.startsWith(prefix));

describe('env_consistency: .env.example, both compose files and code agree', () => {
  const read = varsReadInCode();
  const example = varsIn('.env.example');
  // Comments stripped: a compose file must actually PASS the variable, not
  // mention it (issue #603).
  const compose = varsIn('docker-compose.yml', true);
  const deploy = varsIn('project/infra/deploy/docker-compose.deploy.yml', true);

  it('the widened walk actually sees the trees that were invisible', () => {
    // A guard on the guard: if a refactor moves one of these, the check must
    // fail rather than quietly narrow back to project/src.
    expect(read.has('REDACTION_ENABLED'), 'the redaction family is unseen again').toBe(true);
    expect(read.has('SPACY_MODEL'), 'the redaction sidecar (Python) is unseen').toBe(true);
    expect(read.has('COGETO_MAIL_TLS_CERT'), 'the mail service entrypoint is unseen').toBe(true);
    expect(read.has('ZITADEL_BOOTSTRAP_STATE_FILE'), 'the Zitadel bootstrap is unseen').toBe(true);
    expect(
      read.has('COGETO_MODEL_TIMEOUT_ANSWER_MS'),
      "the read(env, 'NAME') accessor form is unseen",
    ).toBe(true);
    expect(read.has('POSTGRES_PASSWORD'), 'the non-COGETO prefixes are unseen').toBe(true);
  });

  it('every tracked variable the code reads is documented in .env.example or a compose file', () => {
    const undocumented = [...read].filter(
      (v) => !isUndocumentedByDesign(v) && !example.has(v) && !compose.has(v) && !deploy.has(v),
    );
    expect(undocumented, `undocumented env vars read in code: ${undocumented.join(', ')}`).toEqual(
      [],
    );
  });

  it('every tracked variable in .env.example is used by code or wired in compose (no dead entries)', () => {
    const dead = [...entriesIn('.env.example')].filter(
      (v) => !read.has(v) && !compose.has(v) && !deploy.has(v),
    );
    expect(dead, `dead .env.example entries: ${dead.join(', ')}`).toEqual([]);
  });

  // The DELIVERY half (issue #516), which the assertions above cannot see: a
  // variable can be read by code and documented in .env.example while the
  // compose files silently drop it, so setting it in .env does nothing. Every
  // documented, code-read operator variable must be NAMED in the compose file,
  // or the stack is advertising a knob that does not turn.

  it('every documented, code-read variable is wired in docker-compose.yml', () => {
    const dropped = [...read].filter(
      (v) => example.has(v) && !isUndocumentedByDesign(v) && !EVAL_ONLY.has(v) && !compose.has(v),
    );
    expect(dropped, `documented knobs docker-compose.yml drops: ${dropped.join(', ')}`).toEqual([]);
  });

  it('every documented, code-read variable is wired in the deploy compose (demo profile excepted)', () => {
    const dropped = [...read].filter(
      (v) =>
        example.has(v) &&
        !isUndocumentedByDesign(v) &&
        !EVAL_ONLY.has(v) &&
        // A customer stack must not grow a demo switch: the demo profile
        // belongs to the dev stack alone, deliberately.
        !v.startsWith('COGETO_DEMO') &&
        !deploy.has(v),
    );
    expect(dropped, `documented knobs the deploy compose drops: ${dropped.join(', ')}`).toEqual([]);
  });

  /**
   * The rule that catches the CLASS (issue #568). The assertion above only
   * fires for variables `.env.example` happens to document, so a knob the dev
   * compose passes and nobody wrote down could still vanish from the file
   * customers run. This one has no such escape hatch: dev-compose parity is
   * the baseline, and every deviation is named above with its reason.
   */
  it('a variable read by code and passed by the dev compose is passed by the deploy compose too', () => {
    const missing = [...read].filter(
      (v) =>
        compose.has(v) &&
        !deploy.has(v) &&
        !isUndocumentedByDesign(v) &&
        !EVAL_ONLY.has(v) &&
        !hasDeployParityException(v),
    );
    expect(
      missing,
      `the deploy compose drops variables the dev compose passes, with no recorded reason: ` +
        `${missing.join(', ')}. Wire them into project/infra/deploy/docker-compose.deploy.yml, ` +
        `or add each to DEPLOY_PARITY_EXCEPTIONS with why a customer instance must not have it.`,
    ).toEqual([]);
  });

  it('every recorded deploy-parity exception is still a real difference', () => {
    // An exception that no longer applies is a lie the next reader believes.
    const stale = Object.keys(DEPLOY_PARITY_EXCEPTIONS).filter((v) => deploy.has(v));
    expect(
      stale,
      `these are in the deploy compose now — remove their exceptions: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('the demo limit family stays out of the customer compose', () => {
    // F21: COGETO_DEMO_DAILY_UPLOAD_MAX had leaked in while its eight siblings
    // were correctly absent, and the blanket COGETO_DEMO* exception above meant
    // nothing could see it. Absence is now asserted, not merely excused.
    const leaked = [...deploy].filter((v) => v.startsWith('COGETO_DEMO'));
    expect(leaked, `demo-only variables in the customer compose: ${leaked.join(', ')}`).toEqual([]);
  });
});
