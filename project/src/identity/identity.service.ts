import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Principal } from '@cogeto/shared';
import { IDENTITY_OPTIONS } from './identity-options';
import type { IdentityOptions } from './identity-options';
import { fetchUserinfo } from './zitadel-userinfo.client';

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

  constructor(@Inject(IDENTITY_OPTIONS) private readonly options: IdentityOptions) {}

  async resolvePrincipal(accessToken: string): Promise<Principal> {
    const cached = this.cache.get(accessToken);
    if (cached && cached.expiresAt > Date.now()) return cached.principal;

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
    return principal;
  }

  private evictExpired(): void {
    if (this.cache.size < 500) return;
    const now = Date.now();
    for (const [token, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(token);
    }
  }
}
