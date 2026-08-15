import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@cogeto/shared';
import { IDENTITY_OPTIONS } from './identity-options';
import type { IdentityOptions } from './identity-options';
import { fetchUserinfo } from './zitadel-userinfo.client';
import { UserDirectory } from './user-directory';
import { untranslatedError } from '../infrastructure/index';

const ORG_ID_CLAIM = 'urn:zitadel:iam:user:resourceowner:id';
const ORG_NAME_CLAIM = 'urn:zitadel:iam:user:resourceowner:name';
const ROLES_CLAIM = 'urn:zitadel:iam:org:project:roles';

interface CacheEntry {
  principal: Principal;
  expiresAt: number;
}

/**
 * The identity seam (scope §4.5): resolves the authenticated Principal from a
 * Zitadel access token. Token validation is delegated to Zitadel's userinfo
 * endpoint — a valid answer proves the token; claims carry user + organization.
 * (JWKS-based local validation can replace this inside the seam later without
 * touching any caller.)
 */
@Injectable()
export class IdentityService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @Inject(IDENTITY_OPTIONS) private readonly options: IdentityOptions,
    private readonly directory: UserDirectory,
  ) {}

  async resolvePrincipal(accessToken: string): Promise<Principal> {
    const cached = this.cache.get(accessToken);
    if (cached && cached.expiresAt > Date.now()) return cached.principal;

    // when the token is a JWT, validate iss/aud LOCALLY against this
    // instance's configuration before spending a userinfo round-trip. userinfo
    // does not enforce audience, so on a (hypothetical) shared Zitadel a token
    // minted for a different client could otherwise resolve. Opaque tokens
    // (e.g. the demo PAT) cannot be decoded and fall through to userinfo, which
    // — against the instance's OWN Zitadel — is the boundary.
    const claims = this.assertTokenAudienceAndIssuer(accessToken);

    const { status, body } = await fetchUserinfo(
      this.options.internalBaseUrl,
      this.options.externalDomain,
      accessToken,
    );
    if (status !== 200) {
      throw untranslatedError.unauthorized('invalid or expired access token');
    }

    const roles = body[ROLES_CLAIM];
    const principal: Principal = {
      userId: String(body['sub'] ?? ''),
      name: String(body['name'] ?? body['preferred_username'] ?? ''),
      email: typeof body['email'] === 'string' ? body['email'] : null,
      orgId: String(body[ORG_ID_CLAIM] ?? ''),
      orgName: String(body[ORG_NAME_CLAIM] ?? ''),
      roles: roles && typeof roles === 'object' ? Object.keys(roles) : [],
    };
    if (!principal.userId) {
      throw untranslatedError.unauthorized('userinfo response carried no subject');
    }

    // The cache entry may never outlive the TOKEN (audit 2.0 SEC-26). The flat
    // TTL alone meant a token accepted at T stayed accepted for up to the full
    // TTL past its own expiry — a small window, but one where the instance
    // honours a credential the identity provider has already retired. The
    // entry now expires at whichever comes first: our TTL, or the token's
    // `exp`. An opaque token carries no exp we can read, so it keeps the TTL,
    // which is the same bound as before.
    const ttlExpiry = Date.now() + this.options.cacheTtlSeconds * 1000;
    const tokenExpiry = expiryFromClaims(claims);
    this.cache.set(accessToken, {
      principal,
      expiresAt: tokenExpiry === null ? ttlExpiry : Math.min(ttlExpiry, tokenExpiry),
    });
    this.evictExpired();
    // Provision / refresh the directory on each fresh resolve (throttled by the
    // token cache above). Best-effort: a directory write must never fail auth.
    await this.directory.record(principal).catch(() => undefined);
    return principal;
  }

  private evictExpired(): void {
    if (this.cache.size < 500) return;
    const now = Date.now();
    for (const [token, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(token);
    }
  }

  /**
   * if `token` is a JWT (three dot-separated segments), decode its
   * payload — WITHOUT verifying the signature; userinfo below proves the token
   * — and reject a mismatched `iss` or an `aud` that does not include the
   * configured client id. A non-JWT (opaque) token, or missing config, is
   * left to userinfo.
   *
   * Returns the decoded claims (null for an opaque token) so the caller can
   * bound the cache entry by the token's own `exp` (SEC-26). The claims are
   * UNVERIFIED at this point, which is fine for this use: a forged `exp` can
   * only make us cache for a SHORTER time, never longer, because the value is
   * only ever used as a `Math.min` against our own TTL.
   */
  private assertTokenAudienceAndIssuer(token: string): Record<string, unknown> | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null; // opaque token (e.g. a PAT) — cannot decode
    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      throw untranslatedError.unauthorized('malformed access token');
    }
    if (this.options.issuer && claims['iss'] !== this.options.issuer) {
      throw untranslatedError.unauthorized('token issuer not trusted by this instance');
    }
    if (this.options.expectedAudience) {
      const aud = claims['aud'];
      const audiences = Array.isArray(aud) ? aud.map(String) : aud != null ? [String(aud)] : [];
      if (!audiences.includes(this.options.expectedAudience)) {
        throw untranslatedError.unauthorized('token audience is not this instance');
      }
    }
    return claims;
  }
}

/**
 * The token's own expiry as epoch millis, or null when it carries none we can
 * read. `exp` is seconds since the epoch (RFC 7519); anything else is ignored
 * rather than guessed at.
 */
function expiryFromClaims(claims: Record<string, unknown> | null): number | null {
  const exp = claims?.['exp'];
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  return exp * 1000;
}
