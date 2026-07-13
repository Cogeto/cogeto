import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { IdentityService } from './identity.service';
import type { UserDirectory } from './user-directory';

// The userinfo client is a free function (node:http, sets Host) — mock it so the
// seam's claim→Principal mapping is tested with zero live Zitadel.
vi.mock('./zitadel-userinfo.client', () => ({ fetchUserinfo: vi.fn() }));
import { fetchUserinfo } from './zitadel-userinfo.client';

const mockFetch = vi.mocked(fetchUserinfo);
const OPTIONS = {
  internalBaseUrl: 'http://zitadel:8080',
  externalDomain: 'localhost',
  cacheTtlSeconds: 60,
};
// A directory whose record never fails auth (best-effort, per the seam).
const directory = { record: vi.fn().mockResolvedValue(undefined) } as unknown as UserDirectory;

const VALID_BODY = {
  sub: 'user-123',
  name: 'Ada Lovelace',
  email: 'ada@cogeto.localhost',
  'urn:zitadel:iam:user:resourceowner:id': 'org-9',
  'urn:zitadel:iam:user:resourceowner:name': 'Cogeto',
  'urn:zitadel:iam:org:project:roles': { admin: {}, member: {} },
};

describe('identity seam — resolvePrincipal', () => {
  let service: IdentityService;
  beforeEach(() => {
    mockFetch.mockReset();
    service = new IdentityService(OPTIONS, directory);
  });

  it('constructs a Principal from a valid session — org and roles propagate', async () => {
    mockFetch.mockResolvedValue({ status: 200, body: VALID_BODY });
    const principal = await service.resolvePrincipal('good-token');
    expect(principal).toEqual({
      userId: 'user-123',
      name: 'Ada Lovelace',
      email: 'ada@cogeto.localhost',
      orgId: 'org-9',
      orgName: 'Cogeto',
      roles: ['admin', 'member'], // the roles claim is an object; roles are its keys
    });
  });

  it('rejects an invalid / expired token (userinfo non-200)', async () => {
    mockFetch.mockResolvedValue({ status: 401, body: {} });
    await expect(service.resolvePrincipal('bad-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(service.resolvePrincipal('bad-token')).rejects.toThrow(/invalid or expired/i);
  });

  it('rejects a token whose userinfo carries no subject', async () => {
    mockFetch.mockResolvedValue({ status: 200, body: { name: 'No Sub' } });
    await expect(service.resolvePrincipal('subless')).rejects.toThrow(/no subject/i);
  });

  it('caches by token — a repeated call does not re-hit userinfo', async () => {
    mockFetch.mockResolvedValue({ status: 200, body: VALID_BODY });
    await service.resolvePrincipal('tok');
    await service.resolvePrincipal('tok');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('defaults roles to [] when the roles claim is absent', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      body: { sub: 'u', name: 'n', 'urn:zitadel:iam:user:resourceowner:id': 'o' },
    });
    expect((await service.resolvePrincipal('t2')).roles).toEqual([]);
  });
});

// ── QS-17: local iss/aud pre-validation before trusting userinfo ───────────────
const b64url = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url');
/** A JWT-SHAPED token (3 segments; signature not verified — userinfo proves it). */
const jwt = (claims: Record<string, unknown>): string =>
  `${b64url({ alg: 'RS256' })}.${b64url(claims)}.sig`;

describe('identity seam — iss/aud pre-validation (QS-17)', () => {
  const AUD_OPTIONS = {
    internalBaseUrl: 'http://zitadel:8080',
    externalDomain: 'localhost',
    cacheTtlSeconds: 60,
    issuer: 'https://localhost',
    expectedAudience: 'cogeto-spa',
  };
  let service: IdentityService;
  beforeEach(() => {
    mockFetch.mockReset();
    service = new IdentityService(AUD_OPTIONS, directory);
  });

  it('rejects a JWT whose issuer is not this instance — no userinfo round-trip', async () => {
    const token = jwt({ iss: 'https://evil.example', aud: 'cogeto-spa' });
    await expect(service.resolvePrincipal(token)).rejects.toThrow(UnauthorizedException);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a JWT whose audience does not include the client id', async () => {
    const token = jwt({ iss: 'https://localhost', aud: 'some-other-client' });
    await expect(service.resolvePrincipal(token)).rejects.toThrow(UnauthorizedException);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('accepts a JWT with the right iss + aud (aud may be an array), then uses userinfo', async () => {
    mockFetch.mockResolvedValue({ status: 200, body: VALID_BODY });
    const token = jwt({ iss: 'https://localhost', aud: ['cogeto-spa', 'other'] });
    expect((await service.resolvePrincipal(token)).userId).toBe('user-123');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('lets an OPAQUE token (e.g. the demo PAT) through to userinfo unchecked', async () => {
    mockFetch.mockResolvedValue({ status: 200, body: VALID_BODY });
    // No dots → not a JWT → the iss/aud decode is skipped by design.
    expect((await service.resolvePrincipal('opaque-pat-token')).userId).toBe('user-123');
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});

// ── Architecture: the seam is the ONLY place that names Zitadel ────────────────
const SRC_ROOT = path.resolve(__dirname, '..');
function sources(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist') continue;
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) sources(full, acc);
    else if (e.endsWith('.ts') && !e.endsWith('.spec.ts')) acc.push(full);
  }
  return acc;
}

describe('identity seam — architecture', () => {
  it('no module outside identity references Zitadel URLs, claims, or the userinfo client', () => {
    const offenders = sources(SRC_ROOT)
      .filter((f) => !f.includes(`${path.sep}identity${path.sep}`))
      .filter((f) =>
        /zitadel-userinfo\.client|urn:zitadel|\/oidc\/v1\/userinfo|@zitadel/.test(
          readFileSync(f, 'utf8'),
        ),
      );
    expect(offenders.map((f) => path.relative(SRC_ROOT, f))).toEqual([]);
  });
});
