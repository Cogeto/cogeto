/**
 * zitadel-init — one-shot bootstrap job (Addendum §A.2: zero clicks).
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
// The operator/admin role the jobs endpoints require (QS-10). The FirstInstance
// human admin is granted it here so the System view works out of the box; a
// second (non-admin) user logs in fine but without it.
const ADMIN_ROLE = process.env.COGETO_ADMIN_ROLE || 'admin';
const ADMIN_USERNAME = process.env.ZITADEL_ADMIN_USERNAME || 'admin@cogeto.localhost';

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

async function main() {
  await waitFor('zitadel /debug/healthz', async () => {
    const { status } = await request('GET', '/debug/healthz');
    return status === 200;
  });
  await waitFor('machine-user PAT file', () => existsSync(PAT_FILE), 30, 2000);
  const pat = readFileSync(PAT_FILE, 'utf8').trim();

  // 1. Ensure the project exists.
  const search = await request(
    'POST',
    '/management/v1/projects/_search',
    { queries: [{ nameQuery: { name: PROJECT_NAME, method: 'TEXT_QUERY_METHOD_EQUALS' } }] },
    pat,
  );
  if (search.status !== 200) {
    throw new Error(`project search failed (${search.status}): ${JSON.stringify(search.body)}`);
  }
  let projectId = search.body.result?.[0]?.id;
  if (!projectId) {
    const created = await request('POST', '/management/v1/projects', { name: PROJECT_NAME }, pat);
    if (created.status !== 200) {
      throw new Error(`project create failed (${created.status}): ${JSON.stringify(created.body)}`);
    }
    projectId = created.body.id;
    console.log(`created project ${PROJECT_NAME} (${projectId})`);
  } else {
    console.log(`project ${PROJECT_NAME} already exists (${projectId})`);
  }

  // 2. Ensure the SPA OIDC application exists (authorization code + PKCE).
  const apps = await request(`POST`, `/management/v1/projects/${projectId}/apps/_search`, {}, pat);
  if (apps.status !== 200) {
    throw new Error(`app search failed (${apps.status}): ${JSON.stringify(apps.body)}`);
  }
  let app = (apps.body.result ?? []).find((a) => a.name === APP_NAME);
  let clientId = app?.oidcConfig?.clientId;
  if (!clientId) {
    const created = await request(
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
  // endpoints (QS-10) can see them. Without this a fresh instance has no roles
  // and the System view returns 403 to everyone.
  const roleRes = await request(
    'POST',
    `/management/v1/projects/${projectId}/roles`,
    { roleKey: ADMIN_ROLE, displayName: 'Admin', group: '' },
    pat,
  );
  console.log(
    roleRes.status === 200
      ? `created project role '${ADMIN_ROLE}'`
      : `project role '${ADMIN_ROLE}' already present (${roleRes.status})`,
  );
  const assertRes = await request(
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
  );
  // A re-run finds assertion already on → Zitadel answers 400 "No changes";
  // that is success for an idempotent bootstrap, not a failure.
  const assertNoChange =
    typeof assertRes.body?.message === 'string' && assertRes.body.message.includes('No changes');
  if (assertRes.status !== 200 && !assertNoChange) {
    throw new Error(
      `enable role assertion failed (${assertRes.status}): ${JSON.stringify(assertRes.body)}`,
    );
  }
  console.log(
    `role assertion on project '${PROJECT_NAME}' ${assertNoChange ? '(already on)' : 'enabled'}`,
  );

  // 2c. Grant the FirstInstance admin the 'admin' role (idempotent).
  const users = await request(
    'POST',
    '/management/v1/users/_search',
    {
      queries: [
        { emailQuery: { emailAddress: ADMIN_USERNAME, method: 'TEXT_QUERY_METHOD_EQUALS' } },
      ],
    },
    pat,
  );
  const adminUserId = users.body.result?.[0]?.id;
  if (!adminUserId) {
    console.warn(`admin user '${ADMIN_USERNAME}' not found — skipping role grant`);
  } else {
    const grants = await request(
      'POST',
      '/management/v1/users/grants/_search',
      { queries: [{ userIdQuery: { userId: adminUserId } }] },
      pat,
    );
    const hasGrant = (grants.body.result ?? []).some(
      (g) => g.projectId === projectId && (g.roleKeys ?? []).includes(ADMIN_ROLE),
    );
    if (hasGrant) {
      console.log(`admin '${ADMIN_USERNAME}' already has role '${ADMIN_ROLE}'`);
    } else {
      const grant = await request(
        'POST',
        `/management/v1/users/${adminUserId}/grants`,
        { projectId, roleKeys: [ADMIN_ROLE] },
        pat,
      );
      if (grant.status !== 200) {
        throw new Error(`grant admin role failed (${grant.status}): ${JSON.stringify(grant.body)}`);
      }
      console.log(`granted '${ADMIN_ROLE}' to ${ADMIN_USERNAME}`);
    }
  }

  // 3. Publish what the SPA needs.
  writeFileSync(WEB_CONFIG_FILE, JSON.stringify({ issuer: ISSUER, clientId }, null, 2));
  console.log(`wrote ${WEB_CONFIG_FILE}`);
}

main().catch((error) => {
  console.error('zitadel-init failed:', error.message ?? error);
  process.exit(1);
});
