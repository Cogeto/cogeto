export const IDENTITY_OPTIONS = Symbol('IDENTITY_OPTIONS');

/** Provided by the composition roots (entrypoints); the seam reads no env itself. */
export interface IdentityOptions {
  /**
   * Base URL used to reach Zitadel from inside the compose network,
   * e.g. http://zitadel:8080.
   */
  internalBaseUrl: string;
  /**
   * The public external domain (Zitadel resolves its instance by Host header),
   * e.g. "localhost". Sent as Host on internal calls.
   */
  externalDomain: string;
  /** Seconds a resolved principal may be served from cache per token. Kept
   * small (QS-11): it bounds the token-revocation window — a token revoked at
   * Zitadel keeps authenticating for at most this long. */
  cacheTtlSeconds: number;
  /**
   * The OIDC issuer this instance trusts (QS-17), e.g. https://localhost. When
   * the access token is a JWT, its `iss` must match. Absent → the check is
   * skipped (userinfo against the instance's own Zitadel is the boundary).
   */
  issuer?: string;
  /**
   * The SPA client id this instance's tokens must be audienced for (QS-17).
   * When the access token is a JWT, its `aud` must include this. Absent → the
   * aud check is skipped (e.g. opaque PATs, which cannot be decoded).
   */
  expectedAudience?: string;
  /** Zitadel project role the AdminGuard requires (QS-10); default 'admin'. */
  adminRole?: string;
}
