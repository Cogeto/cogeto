import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';

/**
 * Provisions the demo Principal in Zitadel (decision 0022 ruling 1): a machine
 * user (display name "Ana Kovač") with a personal access token. The PAT is a
 * real bearer token — it resolves through the unchanged BearerAuthGuard →
 * userinfo path, so the sandbox authenticates for real; it simply hands the
 * visitor a pre-minted credential. No auth bypass is introduced.
 *
 * Uses node:http because Zitadel resolves its instance from the Host header and
 * the fetch spec forbids overriding Host (same reason as zitadel-init).
 */

export interface ZitadelAdminOptions {
  /** Zitadel reachable inside the compose network, e.g. http://zitadel:8080 */
  internalUrl: string;
  /** The external domain Zitadel resolves its instance by (Host header). */
  externalDomain: string;
  /** Bootstrap machine-user PAT written by FirstInstance (default /machinekey/pat.txt). */
  patFile: string;
  /** Username for the demo machine user (stable → idempotent). */
  userName?: string;
  /** Display name shown in GET /api/me. */
  displayName?: string;
  /** PAT expiry — far out, like the bootstrap PAT. */
  patExpiration?: string;
}

export interface DemoPrincipalCredentials {
  userId: string;
  token: string;
}

const DEFAULTS = {
  userName: 'ana-sandbox',
  displayName: 'Ana Kovač',
  patExpiration: '2035-01-01T00:00:00Z',
};

interface ZResponse {
  status: number;
  body: Record<string, unknown>;
}

function zRequest(
  opts: ZitadelAdminOptions,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<ZResponse> {
  const base = new URL(opts.internalUrl);
  const client = base.protocol === 'https:' ? https : http;
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        host: base.hostname,
        port: base.port || (base.protocol === 'https:' ? 443 : 80),
        path,
        method,
        headers: {
          host: opts.externalDomain,
          'x-forwarded-proto': 'https',
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json: Record<string, unknown>;
          try {
            json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
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

/**
 * Idempotently ensures the demo machine user exists and mints it a fresh PAT.
 * Returns the user id (== the token's `sub`, i.e. the memory owner_id) and token.
 */
export async function provisionDemoPrincipal(
  opts: ZitadelAdminOptions,
): Promise<DemoPrincipalCredentials> {
  const cfg = { ...DEFAULTS, ...opts };
  const pat = (await readFile(cfg.patFile, 'utf8')).trim();
  if (!pat) throw new Error(`bootstrap PAT file ${cfg.patFile} is empty`);

  const userId = await ensureMachineUser(cfg, pat);
  const token = await createPat(cfg, pat, userId);
  return { userId, token };
}

async function ensureMachineUser(
  opts: Required<Pick<ZitadelAdminOptions, 'userName' | 'displayName'>> & ZitadelAdminOptions,
  pat: string,
): Promise<string> {
  const existing = await findUserByUsername(opts, pat, opts.userName);
  if (existing) return existing;

  const created = await zRequest(opts, 'POST', '/management/v1/users/machine', pat, {
    userName: opts.userName,
    name: opts.displayName,
    description: 'Ana sandbox demo Principal (decision 0022) — fictional, disposable.',
    accessTokenType: 'ACCESS_TOKEN_TYPE_BEARER',
  });
  if (created.status === 200 && typeof created.body['userId'] === 'string') {
    return created.body['userId'] as string;
  }
  // A concurrent init may have created it between our search and create.
  const retry = await findUserByUsername(opts, pat, opts.userName);
  if (retry) return retry;
  throw new Error(
    `could not create demo machine user (${created.status}): ${JSON.stringify(created.body)}`,
  );
}

async function findUserByUsername(
  opts: ZitadelAdminOptions,
  pat: string,
  userName: string,
): Promise<string | null> {
  const res = await zRequest(opts, 'POST', '/management/v1/users/_search', pat, {
    queries: [{ userNameQuery: { userName, method: 'TEXT_QUERY_METHOD_EQUALS' } }],
  });
  if (res.status !== 200) return null;
  const result = res.body['result'];
  const first = Array.isArray(result) ? (result[0] as { id?: unknown } | undefined) : undefined;
  return first && typeof first.id === 'string' ? first.id : null;
}

async function createPat(
  opts: Required<Pick<ZitadelAdminOptions, 'patExpiration'>> & ZitadelAdminOptions,
  pat: string,
  userId: string,
): Promise<string> {
  const res = await zRequest(opts, 'POST', `/management/v1/users/${userId}/pats`, pat, {
    expirationDate: opts.patExpiration,
  });
  if (res.status === 200 && typeof res.body['token'] === 'string') {
    return res.body['token'] as string;
  }
  throw new Error(`could not mint demo PAT (${res.status}): ${JSON.stringify(res.body)}`);
}
