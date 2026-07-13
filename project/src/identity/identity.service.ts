import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Principal } from '@cogeto/shared';
import { IDENTITY_OPTIONS } from './identity-options';
import type { IdentityOptions } from './identity-options';
import { fetchUserinfo } from './zitadel-userinfo.client';
import { UserDirectory } from './user-directory';

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

    // QS-17: when the token is a JWT, validate iss/aud LOCALLY against this
    // instance's configuration before spending a userinfo round-trip. userinfo
    // does not enforce audience, so on a (hypothetical) shared Zitadel a token
    // minted for a different client could otherwise resolve. Opaque tokens
    // (e.g. the demo PAT) cannot be decoded and fall through to userinfo, which
    // — against the instance's OWN Zitadel (decision 0019) — is the boundary.
    this.assertTokenAudienceAndIssuer(accessToken);

    const { status, body } = await fetchUserinfo(
      this.options.internalBaseUrl,
      this.options.externalDomain,
      accessToken,
    );
    if (status !== 200) {
      throw new UnauthorizedException('invalid or expired access token');
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
      throw new UnauthorizedException('userinfo response carried no subject');
    }

    this.cache.set(accessToken, {
      principal,
      expiresAt: Date.now() + this.options.cacheTtlSeconds * 1000,
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
   * QS-17: if `token` is a JWT (three dot-separated segments), decode its
   * payload — WITHOUT verifying the signature; userinfo below proves the token
   * — and reject a mismatched `iss` or an `aud` that does not include the
   * configured client id. A non-JWT (opaque) token, or missing config, is
   * left to userinfo.
   */
  private assertTokenAudienceAndIssuer(token: string): void {
    const parts = token.split('.');
    if (parts.length !== 3) return; // opaque token (e.g. a PAT) — cannot decode
    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      throw new UnauthorizedException('malformed access token');
    }
    if (this.options.issuer && claims['iss'] !== this.options.issuer) {
      throw new UnauthorizedException('token issuer not trusted by this instance');
    }
    if (this.options.expectedAudience) {
      const aud = claims['aud'];
      const audiences = Array.isArray(aud) ? aud.map(String) : aud != null ? [String(aud)] : [];
      if (!audiences.includes(this.options.expectedAudience)) {
        throw new UnauthorizedException('token audience is not this instance');
      }
    }
  }
}
