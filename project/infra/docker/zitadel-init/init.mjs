/**
 * zitadel-init — one-shot bootstrap job (the specification: zero clicks).
 *
 * Zitadel's FirstInstance config creates the org, the human admin, and a
 * machine user with a PAT. This job uses that PAT to make the instance usable
 * by the SPA: ensure the "cogeto" project and its OIDC application (SPA, PKCE)
 * exist, then write { issuer, clientId } where the app process serves it as
 * GET /api/config. Idempotent: safe to re-run on every `docker compose up`.
 *
 * Uses node:http because Zitadel resolves its instance from the Host header
 * and the fetch spec forbids overriding Host.
 */
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const INTERNAL_URL = process.env.ZITADEL_INTERNAL_URL ?? 'http://zitadel:8080';
const EXTERNAL_DOMAIN = process.env.ZITADEL_EXTERNAL_DOMAIN ?? 'localhost';
const ISSUER = process.env.COGETO_ISSUER ?? 'https://localhost';
const REDIRECT_URI = process.env.COGETO_REDIRECT_URI ?? 'https://localhost/callback';
const POST_LOGOUT_URI = process.env.COGETO_POST_LOGOUT_URI ?? 'https://localhost/';
const PAT_FILE = process.env.ZITADEL_PAT_FILE ?? '/machinekey/pat.txt';
const WEB_CONFIG_FILE = process.env.COGETO_WEB_CONFIG_FILE ?? '/web-config/config.json';

const PROJECT_NAME = 'cogeto';
const APP_NAME = 'cogeto-web';
// The operator/admin role the jobs endpoints require. The FirstInstance
// human admin is granted it here so the System view works out of the box; a
// second (non-admin) user logs in fine but without it.
const ADMIN_ROLE = process.env.COGETO_ADMIN_ROLE || 'admin';
const ADMIN_USERNAME = process.env.ZITADEL_ADMIN_USERNAME || 'admin@cogeto.localhost';

// SEC-16: the bootstrap PAT is a one-shot credential. After provisioning
// succeeds this job revokes it, blanks pat.txt (so the secret no longer
// persists in the machinekey volume or its backups) and records the
// provisioned inputs in bootstrap-state.json; later runs short-circuit
// against that record instead of needing a live PAT. The ONLY consumer that
// legitimately needs the PAT after bootstrap is the dev sandbox's demo seed,
// so demo mode keeps it (a sandbox holds no real data).
const BOOTSTRAP_USERNAME = process.env.ZITADEL_BOOTSTRAP_MACHINE_USERNAME || 'cogeto-bootstrap';
const STATE_FILE = process.env.ZITADEL_BOOTSTRAP_STATE_FILE ?? '/machinekey/bootstrap-state.json';
const KEEP_PAT_FOR_DEMO =
  process.env.COGETO_DEMO_MODE === '1' ||
  (process.env.COGETO_COMPOSE_PROFILES ?? '')
    .split(',')
    .map((p) => p.trim())
    .includes('demo');

// ── Notification SMTP (optional) ────────────────────────────────────────────
// Zitadel sends the mail a person waits for: an invitation, an address
// verification, a password reset. Given no relay it sends none of them, and
// the failure is invisible — which is fine for a self-hoster who hands
// credentials over in person, and not fine on a platform that provisions
// instances unattended. So the relay arrives in the environment and is applied
// here, through the API, with the bootstrap PAT this job already holds.
//
// Every value empty means NO SMTP, which is exactly how an instance runs
// today: nothing is read, nothing is called, nothing is recorded. A PARTIAL
// set is a configuration error and is refused by name, because the alternative
// is a half-configuration that fails at send time, where nobody sees it.
//
// The names are written as a `{ env: 'NAME' }` list so the env-consistency
// check can see them; a dynamic `env[name]` read would be invisible to it.
const SMTP_VARS = [
  { setting: 'host', env: 'ZITADEL_SMTP_HOST' },
  { setting: 'user', env: 'ZITADEL_SMTP_USER' },
  { setting: 'password', env: 'ZITADEL_SMTP_PASSWORD' },
  { setting: 'tls', env: 'ZITADEL_SMTP_TLS' },
  { setting: 'from', env: 'ZITADEL_SMTP_FROM' },
  { setting: 'fromName', env: 'ZITADEL_SMTP_FROM_NAME' },
];

/** What Zitadel itself refuses to store without (observed on v4.17.1: an
 * empty host, sender address or sender name is a 400 from its validator),
 * plus TLS, which has no safe default: silently sending a credential in the
 * clear because a variable was forgotten is not a default, it is a defect. */
const SMTP_REQUIRED = ['host', 'from', 'fromName', 'tls'];

/** The description marking the one SMTP configuration this job owns. */
const SMTP_DESCRIPTION = 'cogeto';

const smtpVar = (setting) => SMTP_VARS.find((v) => v.setting === setting).env;

/**
 * The notification-SMTP settings the environment describes, or null when it
 * describes none. Throws on a partial or unusable set, naming exactly which
 * variables are at fault and never quoting the credential.
 */
export function readSmtpSettings(env) {
  const raw = Object.fromEntries(SMTP_VARS.map((v) => [v.setting, (env[v.env] ?? '').trim()]));
  if (Object.values(raw).every((value) => value === '')) return null;

  const missing = SMTP_REQUIRED.filter((setting) => raw[setting] === '').map(smtpVar);
  // Authentication is all or nothing: a relay that needs no credentials is a
  // legitimate configuration, half a credential never is.
  if (raw.user !== '' && raw.password === '') missing.push(smtpVar('password'));
  if (raw.password !== '' && raw.user === '') missing.push(smtpVar('user'));
  if (missing.length > 0) {
    throw new Error(
      `notification SMTP is only partly configured: ${missing.join(', ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} missing. ` +
        `${missing.length === 1 ? 'Set it' : 'Set them'}, or leave every ` +
        `ZITADEL_SMTP_* value empty to run with no outbound mail. Applying half a ` +
        `configuration would fail later at send time, where the failure is invisible and ` +
        `lands on someone waiting for an invitation.`,
    );
  }
  if (raw.tls !== 'true' && raw.tls !== 'false') {
    throw new Error(
      `${smtpVar('tls')} must be exactly "true" or "false"; it is ${JSON.stringify(raw.tls)}. ` +
        `Whether the credential travels encrypted is not something to default silently.`,
    );
  }
  return {
    host: raw.host,
    user: raw.user,
    password: raw.password,
    tls: raw.tls === 'true',
    from: raw.from,
    fromName: raw.fromName,
  };
}

/**
 * The SMTP identity recorded beside the other provisioned inputs: the
 * addressable facts, never the credential. A rotated secret must not be able
 * to stop an instance from booting, and a hash of a secret in a state file is
 * still a secret.
 */
const SMTP_INPUT_KEYS = ['smtpHost', 'smtpUser', 'smtpTls', 'smtpFrom', 'smtpFromName'];

const smtpInputs = (smtp) =>
  smtp === null
    ? {}
    : {
        smtpHost: smtp.host,
        smtpUser: smtp.user,
        smtpTls: smtp.tls,
        smtpFrom: smtp.from,
        smtpFromName: smtp.fromName,
      };

/** The inputs whose change would require re-provisioning (and thus a PAT).
 * With no SMTP configured this is key-for-key what it was before notification
 * mail existed, so the state file an unconfigured instance writes is
 * unchanged. */
export const provisionedInputs = (smtp) => ({
  externalDomain: EXTERNAL_DOMAIN,
  issuer: ISSUER,
  redirectUri: REDIRECT_URI,
  postLogoutUri: POST_LOGOUT_URI,
  adminUsername: ADMIN_USERNAME,
  adminRole: ADMIN_ROLE,
  ...smtpInputs(smtp),
});

const base = new URL(INTERNAL_URL);

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: base.hostname,
        port: base.port || 80,
        path,
        method,
        headers: {
          host: EXTERNAL_DOMAIN,
          'x-forwarded-proto': 'https',
          'content-type': 'application/json',
          accept: 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 10_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = raw ? JSON.parse(raw) : {};
          } catch {
            json = { raw };
          }
          resolve({ status: res.statusCode ?? 0, body: json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${method} ${path} timed out`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Bounded retries around the management API ───────────────────────────────
// /debug/healthz answers before the management API gateway has finished
// binding, so on fast hardware the first call (and, since the gateway can
// accept one request while still settling, ANY later call) can come back 503
// or with a refused/reset connection. A half-provisioned instance is worse
// than a failed one, so every management and admin call is retried, bounded by
// both an attempt count and a wall-clock window.
export const RETRY_ATTEMPTS = 10;
export const RETRY_WINDOW_MS = 120_000;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 5_000;

/**
 * "Not yet" is a gateway that has not finished binding: HTTP 503, and
 * connection-level failures meaning refused, reset, or a dial/DNS failure.
 * Everything else was understood by the server — an authentication failure, a
 * rejected request, any other status — and is handed straight back to the call
 * site, which already knows which statuses it tolerates. Retrying a rejected
 * call only hides its cause. A timeout is NOT "not yet": it means the request
 * may well have been processed, and today it already fails the init.
 */
const NOT_YET_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
]);

export function isNotYet(outcome) {
  if (outcome instanceof Error) return NOT_YET_ERROR_CODES.has(outcome.code);
  return outcome?.status === 503;
}

const describeOutcome = (outcome) =>
  outcome instanceof Error
    ? `${outcome.code ?? 'error'}: ${outcome.message}`
    : `HTTP ${outcome.status}`;

/**
 * Zitadel answers 400 "No changes" when an idempotent write asks for what is
 * already true. For a bootstrap that re-runs on every `docker compose up` that
 * is success, not failure.
 */
const isNoChange = (response) =>
  typeof response.body?.message === 'string' && response.body.message.includes('No changes');

/**
 * One management/admin API call, retried while the gateway says "not yet".
 *
 * `recheck` keeps a retry idempotent for the call sites that CREATE something:
 * a connection reset can arrive after the server already applied the change,
 * so before every retry attempt the caller's existence check runs again and,
 * when it finds the thing, its answer becomes the result. Nothing is created
 * twice.
 */
export async function api(
  method,
  path,
  body,
  token,
  { label, recheck, attempts = RETRY_ATTEMPTS, windowMs = RETRY_WINDOW_MS, call = request } = {},
) {
  const what = label ?? `${method} ${path}`;
  const startedAt = Date.now();
  let attempt = 0;
  let last;
  for (;;) {
    if (attempt > 0 && recheck) {
      const existing = await recheck();
      if (existing) {
        console.log(`${what}: already applied — retry converged without repeating the call`);
        return existing;
      }
    }
    attempt += 1;
    try {
      const response = await call(method, path, body, token);
      if (!isNotYet(response)) return response;
      last = response;
    } catch (error) {
      if (!isNotYet(error)) throw error;
      last = error;
    }
    const elapsed = Date.now() - startedAt;
    if (attempt >= attempts || elapsed >= windowMs) {
      throw new Error(
        `${what}: the zitadel management API never became available — ` +
          `${attempt} attempt(s) over ${Math.round(elapsed / 1000)}s, ` +
          `last failure ${describeOutcome(last)}`,
      );
    }
    const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
    console.log(
      `${what}: ${describeOutcome(last)} — management API not ready yet, waiting ${delay}ms ` +
        `(attempt ${attempt}/${attempts}, ${Math.round(elapsed / 1000)}s elapsed)`,
    );
    await sleep(delay);
  }
}

async function waitFor(description, probe, attempts = 60, delayMs = 2000) {
  for (let i = 0; i < attempts; i++) {
    try {
      if (await probe()) return;
    } catch {
      // keep waiting
    }
    await sleep(delayMs);
  }
  throw new Error(`timed out waiting for ${description}`);
}

/**
 * SEC-16 short-circuit: once the PAT has been revoked, later `docker compose
 * up` runs must not (and cannot) re-provision. If nothing material changed,
 * the recorded state IS the verification; if an input drifted (e.g. the
 * operator changed the domain), fail loudly with the recovery path instead of
 * silently serving a stale OIDC config.
 */
export function shortCircuitFromState(smtp) {
  if (!existsSync(STATE_FILE)) return false;
  let state;
  try {
    state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return false; // unreadable state — fall through to normal provisioning
  }
  if (!state.revoked) return false; // PAT still live — re-run provisioning
  const want = provisionedInputs(smtp);
  const changed = Object.keys(want).filter((key) => state.inputs?.[key] !== want[key]);
  // SMTP taken back OUT of the environment is the one change the comparison
  // above cannot see: its keys are simply absent from `want`.
  const removed =
    smtp === null ? SMTP_INPUT_KEYS.filter((key) => state.inputs?.[key] !== undefined) : [];
  const isSmtp = (key) => SMTP_INPUT_KEYS.includes(key);
  const smtpDrift = [...changed.filter(isSmtp), ...removed];
  const drift = changed.filter((key) => !isSmtp(key));
  if (drift.length > 0) {
    throw new Error(
      `provisioning inputs changed (${drift.join(', ')}) but the bootstrap PAT ` +
        `was revoked after the previous provisioning. Recovery: in the Zitadel console create a ` +
        `new personal access token for the '${BOOTSTRAP_USERNAME}' machine user, write it to ` +
        `${PAT_FILE}, delete ${STATE_FILE}, and re-run \`docker compose up\` ` +
        `(see the operator runbook, "Changing the domain after install").`,
    );
  }
  // Notification mail is not the OIDC configuration: a stale relay leaves the
  // instance serving perfectly, it only means invitations keep going where
  // they went before. Taking the stack down over it would be the larger
  // outage, so this says loudly what was NOT applied and how to apply it,
  // and lets the instance come up.
  if (removed.length > 0) {
    // Deleting the variables stops this job MANAGING the relay; it does not
    // switch off one Zitadel already has, and quietly implying otherwise is
    // how someone concludes that mail is off when it is not.
    console.warn(
      `the notification SMTP settings are gone from the environment ` +
        `(${removed.join(', ')}), but Zitadel keeps the relay it was provisioned with and ` +
        `KEEPS SENDING through it: this job configures outbound mail, it never switches it ` +
        `off. Deactivate it in the Zitadel console (Settings, SMTP provider) if that is what ` +
        `was meant.`,
    );
  } else if (smtpDrift.length > 0) {
    console.warn(
      `notification SMTP changed in the environment (${smtpDrift.join(', ')}) but this ` +
        `instance was already provisioned and its bootstrap PAT was revoked (SEC-16), so ` +
        `NOTHING was applied: Zitadel keeps sending with the settings it was provisioned ` +
        `with. The instance is otherwise unaffected. To apply the change, mint a new personal ` +
        `access token for the '${BOOTSTRAP_USERNAME}' machine user, write it to ${PAT_FILE}, ` +
        `delete ${STATE_FILE}, and re-run \`docker compose up\` (see the operator runbook, ` +
        `"Changing outbound mail after install").`,
    );
  }
  console.log(
    'zitadel already provisioned and the bootstrap PAT is revoked (SEC-16) — nothing to do',
  );
  return true;
}

/**
 * Notification mail: make the ACTIVE Zitadel SMTP configuration the one the
 * environment describes, creating it once and updating it thereafter.
 *
 * How v4.17.1 models this, observed against a live instance rather than
 * assumed, because getting it wrong is what produces a second configuration
 * that silently wins or silently loses:
 *
 *   - POST /admin/v1/smtp/_search lists EVERY configuration with its state;
 *   - GET  /admin/v1/smtp answers only the ACTIVE one, and 404s while none is
 *     active, so a configuration a previous run created but never activated is
 *     invisible there. Listing is therefore the only honest way to find what
 *     is already here, and is what keeps a re-run from adding a second
 *     configuration beside the first;
 *   - POST /admin/v1/smtp creates it INACTIVE and returns its id, carrying the
 *     password so a freshly created configuration is complete in one call;
 *   - POST /admin/v1/smtp/{id}/_activate activates it, and answers 400
 *     Errors.SMTPConfig.AlreadyActive when it already is;
 *   - PUT  /admin/v1/smtp/{id} replaces the settings and carries no password;
 *   - PUT  /admin/v1/smtp/{id}/password is the credential's own call, and it
 *     is refused with 404 COMMAND-rDHzqjGuKQ unless that configuration is the
 *     ACTIVE one. Hence the order below: settle the configuration, activate
 *     it, and only then rotate the credential.
 *
 * The listing is a projection and lags its writes, so nothing here reads a
 * write back through it; the final check polls, because the alternative is a
 * provisioning that fails on a timing difference rather than on a fact.
 *
 * The configuration this job owns is the one whose description is
 * SMTP_DESCRIPTION; anything an operator added by hand is left alone, and
 * activating ours is what makes ours the one that sends.
 */
export async function ensureSmtp(pat, smtp, { call } = {}) {
  if (smtp === null) return;
  const desired = {
    senderAddress: smtp.from,
    senderName: smtp.fromName,
    tls: smtp.tls,
    host: smtp.host,
    user: smtp.user,
  };
  const options = (label, extra = {}) => ({ label, ...(call ? { call } : {}), ...extra });

  const findOurs = async () => {
    const list = await api(
      'POST',
      '/admin/v1/smtp/_search',
      {},
      pat,
      options('SMTP configuration list'),
    );
    if (list.status !== 200) {
      throw new Error(`smtp list failed (${list.status}): ${JSON.stringify(list.body)}`);
    }
    return (
      (list.body.result ?? []).find((config) => config.description === SMTP_DESCRIPTION) ?? null
    );
  };

  /**
   * The listing is a projection and lags the write that fed it, so a create
   * whose answer was lost may not be listed yet. Only the convergence check
   * needs this: reading "nothing is there" too early is what would create a
   * SECOND configuration.
   */
  const findOursSettled = async () => {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const found = await findOurs();
      if (found) return found;
      await sleep(1000);
    }
    return null;
  };

  const ours = await findOurs();
  let id;
  let active;
  if (ours === null) {
    const created = await api(
      'POST',
      '/admin/v1/smtp',
      { ...desired, description: SMTP_DESCRIPTION, password: smtp.password },
      pat,
      // A reset connection can arrive after the create already landed, so
      // every retry looks again first: one configuration is created, or none.
      options('SMTP configuration create', {
        recheck: async () => {
          const existing = await findOursSettled();
          return existing ? { status: 200, body: { id: existing.id } } : null;
        },
      }),
    );
    if (created.status !== 200) {
      throw new Error(`smtp create failed (${created.status}): ${JSON.stringify(created.body)}`);
    }
    id = created.body.id;
    if (!id) throw new Error('smtp create was accepted but answered no configuration id');
    // A create always lands inactive, and the id it answered is the answer:
    // reading it back through the listing would race the projection.
    active = false;
    console.log(`created the notification SMTP configuration (host ${smtp.host})`);
  } else {
    id = ours.id;
    active = ours.state === 'SMTP_CONFIG_ACTIVE';
    // Zitadel's proto-JSON omits empty strings and false booleans entirely, so
    // an absent field means "" or false; normalize before comparing.
    const current = (key) => ours[key] ?? (typeof desired[key] === 'boolean' ? false : '');
    const drift = Object.keys(desired).filter((key) => current(key) !== desired[key]);
    if (drift.length === 0) {
      console.log('notification SMTP configuration already matches the environment');
    } else {
      const updated = await api(
        'PUT',
        `/admin/v1/smtp/${id}`,
        { ...desired, description: SMTP_DESCRIPTION },
        pat,
        // A whole-settings replace: repeating it converges by construction.
        options('SMTP configuration update'),
      );
      if (updated.status !== 200 && !isNoChange(updated)) {
        throw new Error(`smtp update failed (${updated.status}): ${JSON.stringify(updated.body)}`);
      }
      console.log(`notification SMTP configuration updated (${drift.join(', ')})`);
    }
  }

  if (!active) {
    const activated = await api(
      'POST',
      `/admin/v1/smtp/${id}/_activate`,
      {},
      pat,
      options('SMTP configuration activate'),
    );
    const alreadyActive =
      typeof activated.body?.message === 'string' &&
      activated.body.message.includes('AlreadyActive');
    if (activated.status !== 200 && !alreadyActive && !isNoChange(activated)) {
      throw new Error(
        `smtp activate failed (${activated.status}): ${JSON.stringify(activated.body)}`,
      );
    }
  }

  // Self-verify, like every other applied setting here: the ACTIVE
  // configuration must be ours, at the host the environment named. This read
  // comes from the projection, so it is polled: a provisioning that failed
  // because a read model was a second behind would be a lie about the state.
  let serving = null;
  for (let attempt = 0; attempt < 15 && serving === null; attempt += 1) {
    if (attempt > 0) await sleep(1000);
    const verify = await api(
      'GET',
      '/admin/v1/smtp',
      null,
      pat,
      options('SMTP configuration re-read'),
    );
    const answered = verify.status === 200 ? verify.body.smtpConfig : null;
    if (answered?.id === id) serving = answered;
  }
  if (serving === null || (serving.host ?? '') !== smtp.host) {
    throw new Error(
      `notification SMTP did not stick: the active configuration is not ${id} at host ` +
        `${smtp.host}`,
    );
  }

  // The credential goes in LAST, because Zitadel refuses to change the
  // password of a configuration that is not the active one. It is written on
  // every provisioning run, which is what makes rotating it a re-rendered
  // environment and a re-run. Nothing reads it back, and neither it nor the
  // answer to this call is ever logged: the status alone says whether it was
  // accepted.
  if (smtp.password !== '') {
    const password = await api(
      'PUT',
      `/admin/v1/smtp/${id}/password`,
      { password: smtp.password },
      pat,
      options('SMTP credential update'),
    );
    if (password.status !== 200 && !isNoChange(password)) {
      throw new Error(`smtp credential update failed (${password.status})`);
    }
  }
  console.log(
    `notification SMTP active: host ${smtp.host}, sender ${smtp.from}, ` +
      `TLS ${smtp.tls ? 'on' : 'off'}, authenticated ${smtp.user === '' ? 'no' : 'yes'} — ` +
      `verified by re-read`,
  );
}

/**
 * Revoke every PAT of the bootstrap machine user, then SELF-VERIFY: the token
 * must stop authenticating. Returns true only when the API confirms the
 * revocation took effect.
 */
async function revokeBootstrapPat(pat) {
  const users = await api(
    'POST',
    '/management/v1/users/_search',
    {
      queries: [
        { userNameQuery: { userName: BOOTSTRAP_USERNAME, method: 'TEXT_QUERY_METHOD_EQUALS' } },
      ],
    },
    pat,
    { label: 'bootstrap machine user search' },
  );
  const userId = users.body.result?.[0]?.id;
  if (!userId) {
    console.warn(`bootstrap machine user '${BOOTSTRAP_USERNAME}' not found — cannot revoke`);
    return false;
  }
  const pats = await api('POST', `/management/v1/users/${userId}/pats/_search`, {}, pat, {
    label: 'bootstrap PAT list',
  });
  if (pats.status !== 200) {
    console.warn(`PAT list failed (${pats.status}): ${JSON.stringify(pats.body)}`);
    return false;
  }
  for (const token of pats.body.result ?? []) {
    const removed = await api(
      'DELETE',
      `/management/v1/users/${userId}/pats/${token.id}`,
      null,
      pat,
      { label: `bootstrap PAT ${token.id} removal` },
    );
    // Removing the token we are authenticating with may already answer 401 for
    // the LAST delete — the verification below is the arbiter, not this status.
    if (removed.status !== 200 && removed.status !== 401) {
      console.warn(`PAT ${token.id} removal answered ${removed.status}`);
    }
  }
  // Self-verify: the PAT must no longer authenticate. Zitadel's projections
  // can lag a moment, so poll briefly rather than trust a single read.
  for (let i = 0; i < 15; i++) {
    const probe = await api('POST', '/management/v1/projects/_search', {}, pat, {
      label: 'bootstrap PAT revocation self-check',
    });
    if (probe.status === 401 || probe.status === 403) return true;
    await sleep(2000);
  }
  console.warn('bootstrap PAT still authenticates after revocation — leaving it in place');
  return false;
}

async function main() {
  // Read before anything else happens: a partly configured relay is a
  // configuration error, and the cheapest place to say so is before the first
  // API call, not at send time weeks later.
  const smtp = readSmtpSettings(process.env);
  if (shortCircuitFromState(smtp)) return;
  await waitFor('zitadel /debug/healthz', async () => {
    const { status } = await request('GET', '/debug/healthz');
    return status === 200;
  });
  await waitFor('machine-user PAT file', () => existsSync(PAT_FILE), 30, 2000);
  const pat = readFileSync(PAT_FILE, 'utf8').trim();

  // 1. Ensure the project exists.
  const findProject = () =>
    api(
      'POST',
      '/management/v1/projects/_search',
      { queries: [{ nameQuery: { name: PROJECT_NAME, method: 'TEXT_QUERY_METHOD_EQUALS' } }] },
      pat,
      { label: 'project search' },
    );
  const search = await findProject();
  if (search.status !== 200) {
    throw new Error(`project search failed (${search.status}): ${JSON.stringify(search.body)}`);
  }
  let projectId = search.body.result?.[0]?.id;
  if (!projectId) {
    // A reset connection can arrive after the create landed, so every retry
    // re-searches first: the project is created once or not at all.
    const created = await api('POST', '/management/v1/projects', { name: PROJECT_NAME }, pat, {
      label: 'project create',
      recheck: async () => {
        const again = await findProject();
        const found = again.status === 200 ? again.body.result?.[0]?.id : undefined;
        return found ? { status: 200, body: { id: found } } : null;
      },
    });
    if (created.status !== 200) {
      throw new Error(`project create failed (${created.status}): ${JSON.stringify(created.body)}`);
    }
    projectId = created.body.id;
    console.log(`created project ${PROJECT_NAME} (${projectId})`);
  } else {
    console.log(`project ${PROJECT_NAME} already exists (${projectId})`);
  }

  // 2. Ensure the SPA OIDC application exists (authorization code + PKCE).
  const findApps = () =>
    api('POST', `/management/v1/projects/${projectId}/apps/_search`, {}, pat, {
      label: 'app search',
    });
  const apps = await findApps();
  if (apps.status !== 200) {
    throw new Error(`app search failed (${apps.status}): ${JSON.stringify(apps.body)}`);
  }
  let app = (apps.body.result ?? []).find((a) => a.name === APP_NAME);
  let clientId = app?.oidcConfig?.clientId;
  if (!clientId) {
    const created = await api(
      'POST',
      `/management/v1/projects/${projectId}/apps/oidc`,
      {
        name: APP_NAME,
        redirectUris: [REDIRECT_URI],
        postLogoutRedirectUris: [POST_LOGOUT_URI],
        responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
        grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE', 'OIDC_GRANT_TYPE_REFRESH_TOKEN'],
        appType: 'OIDC_APP_TYPE_USER_AGENT',
        authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
        accessTokenType: 'OIDC_TOKEN_TYPE_BEARER',
        devMode: false,
      },
      pat,
      {
        label: 'OIDC app create',
        // Same reasoning as the project create: converge on the app a lost
        // response may already have created rather than registering a second.
        recheck: async () => {
          const again = await findApps();
          if (again.status !== 200) return null;
          const existing = (again.body.result ?? []).find((a) => a.name === APP_NAME);
          return existing?.oidcConfig?.clientId
            ? { status: 200, body: { clientId: existing.oidcConfig.clientId } }
            : null;
        },
      },
    );
    if (created.status !== 200) {
      throw new Error(`app create failed (${created.status}): ${JSON.stringify(created.body)}`);
    }
    clientId = created.body.clientId;
    console.log(`created OIDC app ${APP_NAME} (client ${clientId})`);
  } else {
    console.log(`OIDC app ${APP_NAME} already exists (client ${clientId})`);
  }

  // 2b. Ensure the operator 'admin' role exists AND is asserted into tokens, so
  // the seam's userinfo call carries roles and the AdminGuard on the jobs
  // endpoints can see them. Without this a fresh instance has no roles
  // and the System view returns 403 to everyone.
  // Naturally idempotent: a second create of the same role key is refused by
  // Zitadel and the non-200 is already treated as "already present".
  const roleRes = await api(
    'POST',
    `/management/v1/projects/${projectId}/roles`,
    { roleKey: ADMIN_ROLE, displayName: 'Admin', group: '' },
    pat,
    { label: `project role '${ADMIN_ROLE}' create` },
  );
  console.log(
    roleRes.status === 200
      ? `created project role '${ADMIN_ROLE}'`
      : `project role '${ADMIN_ROLE}' already present (${roleRes.status})`,
  );
  const assertRes = await api(
    'PUT',
    `/management/v1/projects/${projectId}`,
    {
      name: PROJECT_NAME,
      projectRoleAssertion: true,
      // Keep role/project checks OFF so a second, un-granted user can still log
      // in (they simply lack the admin role) — only the jobs endpoints gate.
      projectRoleCheck: false,
      hasProjectCheck: false,
      privateLabelingSetting: 'PRIVATE_LABELING_SETTING_UNSPECIFIED',
    },
    pat,
    // A full replace with fixed values: repeating it converges by construction.
    { label: 'enable role assertion' },
  );
  // A re-run finds assertion already on → Zitadel answers 400 "No changes";
  // that is success for an idempotent bootstrap, not a failure.
  const assertNoChange = isNoChange(assertRes);
  if (assertRes.status !== 200 && !assertNoChange) {
    throw new Error(
      `enable role assertion failed (${assertRes.status}): ${JSON.stringify(assertRes.body)}`,
    );
  }
  console.log(
    `role assertion on project '${PROJECT_NAME}' ${assertNoChange ? '(already on)' : 'enabled'}`,
  );

  // 2c. Grant the FirstInstance admin the 'admin' role (idempotent).
  const users = await api(
    'POST',
    '/management/v1/users/_search',
    {
      queries: [
        { emailQuery: { emailAddress: ADMIN_USERNAME, method: 'TEXT_QUERY_METHOD_EQUALS' } },
      ],
    },
    pat,
    { label: 'admin user search' },
  );
  const adminUserId = users.body.result?.[0]?.id;
  if (!adminUserId) {
    console.warn(`admin user '${ADMIN_USERNAME}' not found — skipping role grant`);
  } else {
    const findGrants = () =>
      api(
        'POST',
        '/management/v1/users/grants/_search',
        { queries: [{ userIdQuery: { userId: adminUserId } }] },
        pat,
        { label: 'admin role grant search' },
      );
    const grantExists = (res) =>
      (res.body.result ?? []).some(
        (g) => g.projectId === projectId && (g.roleKeys ?? []).includes(ADMIN_ROLE),
      );
    const grants = await findGrants();
    const hasGrant = grantExists(grants);
    if (hasGrant) {
      console.log(`admin '${ADMIN_USERNAME}' already has role '${ADMIN_ROLE}'`);
    } else {
      const grant = await api(
        'POST',
        `/management/v1/users/${adminUserId}/grants`,
        { projectId, roleKeys: [ADMIN_ROLE] },
        pat,
        {
          label: 'grant admin role',
          // Zitadel refuses a duplicate grant, but re-checking first keeps the
          // refusal off the happy path when a retry follows a landed create.
          recheck: async () => {
            const again = await findGrants();
            return again.status === 200 && grantExists(again) ? { status: 200, body: {} } : null;
          },
        },
      );
      if (grant.status !== 200) {
        throw new Error(`grant admin role failed (${grant.status}): ${JSON.stringify(grant.body)}`);
      }
      console.log(`granted '${ADMIN_ROLE}' to ${ADMIN_USERNAME}`);
    }
  }

  // 2d. Harden the instance login surface. Idempotent AND
  // self-verifying: after any change the policy is re-read and every desired
  // value asserted — a silently-ignored field can never pass as hardened.
  //   allowRegister=false          operator-created users only, no self-signup
  //   allowExternalIdp=false       no IdPs are configured; removes dead UI
  //   ignoreUnknownUsernames=true  login does not reveal whether a user exists
  const desiredLogin = {
    allowRegister: false,
    allowExternalIdp: false,
    ignoreUnknownUsernames: true,
  };
  const policyRes = await api('GET', '/admin/v1/policies/login', null, pat, {
    label: 'login policy read',
  });
  if (policyRes.status !== 200) {
    throw new Error(
      `login policy read failed (${policyRes.status}): ${JSON.stringify(policyRes.body)}`,
    );
  }
  const currentLogin = policyRes.body.policy ?? {};
  // Zitadel's proto-JSON omits false-valued booleans entirely: an absent field
  // means false, so normalize before comparing (verified against v2.65.1).
  const boolOf = (policy, key) => policy?.[key] ?? false;
  const loginDrift = Object.entries(desiredLogin).filter(([k, v]) => boolOf(currentLogin, k) !== v);
  if (loginDrift.length === 0) {
    console.log('login policy already hardened (register off, external IdP off, no enumeration)');
  } else {
    // UpdateLoginPolicy replaces the whole policy: send the current one merged
    // with the desired values so nothing else is clobbered.
    const restOfPolicy = { ...currentLogin };
    delete restOfPolicy.details;
    delete restOfPolicy.isDefault;
    const update = await api(
      'PUT',
      '/admin/v1/policies/login',
      { ...restOfPolicy, ...desiredLogin },
      pat,
      // A whole-policy replace: idempotent, and the re-read below is the arbiter.
      { label: 'login policy update' },
    );
    if (update.status !== 200 && !isNoChange(update)) {
      throw new Error(
        `login policy update failed (${update.status}): ${JSON.stringify(update.body)}`,
      );
    }
    const verify = await api('GET', '/admin/v1/policies/login', null, pat, {
      label: 'login policy re-read',
    });
    for (const [key, want] of Object.entries(desiredLogin)) {
      if (boolOf(verify.body.policy, key) !== want) {
        throw new Error(
          `login policy hardening did not stick: ${key} is ${JSON.stringify(
            verify.body.policy?.[key],
          )}, wanted ${want}`,
        );
      }
    }
    console.log(
      `login policy hardened (${loginDrift.map(([k]) => k).join(', ')}) — verified by re-read`,
    );
  }

  // 2e. Forbid public org registration at the instance level (single-tenant
  // deployment boundary; same self-verifying pattern).
  const restrRes = await api('GET', '/admin/v1/restrictions', null, pat, {
    label: 'restrictions read',
  });
  if (restrRes.status !== 200) {
    throw new Error(
      `restrictions read failed (${restrRes.status}): ${JSON.stringify(restrRes.body)}`,
    );
  }
  if ((restrRes.body.disallowPublicOrgRegistration ?? false) === true) {
    console.log('public org registration already disallowed');
  } else {
    const setRestr = await api(
      'PUT',
      '/admin/v1/restrictions',
      { disallowPublicOrgRegistration: true },
      pat,
      // Setting a fixed value: repeating it converges by construction.
      { label: 'restrictions update' },
    );
    if (setRestr.status !== 200 && !isNoChange(setRestr)) {
      throw new Error(
        `restrictions update failed (${setRestr.status}): ${JSON.stringify(setRestr.body)}`,
      );
    }
    const verifyRestr = await api('GET', '/admin/v1/restrictions', null, pat, {
      label: 'restrictions re-read',
    });
    if (verifyRestr.body.disallowPublicOrgRegistration !== true) {
      throw new Error(
        `restrictions hardening did not stick: disallowPublicOrgRegistration is ${JSON.stringify(
          verifyRestr.body.disallowPublicOrgRegistration,
        )}`,
      );
    }
    console.log('public org registration disallowed — verified by re-read');
  }

  // 2f. Notification mail. Absent configuration applies nothing and calls
  // nothing, which is how an instance with no relay has always run.
  await ensureSmtp(pat, smtp);

  // 3. Publish what the SPA needs.
  writeFileSync(WEB_CONFIG_FILE, JSON.stringify({ issuer: ISSUER, clientId }, null, 2));
  console.log(`wrote ${WEB_CONFIG_FILE}`);

  // 4. SEC-16: provisioning succeeded — retire the bootstrap PAT.
  if (KEEP_PAT_FOR_DEMO) {
    writeFileSync(
      STATE_FILE,
      JSON.stringify(
        { revoked: false, keptForDemo: true, inputs: provisionedInputs(smtp) },
        null,
        2,
      ),
    );
    console.warn(
      'demo mode: bootstrap PAT KEPT for the demo seed — acceptable only on a disposable ' +
        'sandbox with no real data (SEC-16 residual)',
    );
    return;
  }
  const revoked = await revokeBootstrapPat(pat);
  if (revoked) {
    // Blank the secret material so it stops persisting in the machinekey
    // volume and every backup of it. The state file is now the record.
    writeFileSync(PAT_FILE, '');
    writeFileSync(
      STATE_FILE,
      JSON.stringify({ revoked: true, inputs: provisionedInputs(smtp) }, null, 2),
    );
    console.log('bootstrap PAT revoked and pat.txt blanked — verified by re-auth refusal');
  } else {
    writeFileSync(
      STATE_FILE,
      JSON.stringify({ revoked: false, inputs: provisionedInputs(smtp) }, null, 2),
    );
    console.warn(
      'bootstrap PAT could NOT be revoked; it remains valid until its expiry. ' +
        'Provisioning itself succeeded, so the stack continues; revoke manually in the ' +
        'Zitadel console (Users → Cogeto Bootstrap → Personal Access Tokens).',
    );
  }
}

// Running the file provisions; importing it (the retry spec) does not.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('zitadel-init failed:', error.message ?? error);
    process.exit(1);
  });
}
