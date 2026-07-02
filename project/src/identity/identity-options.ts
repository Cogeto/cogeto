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
  /** Seconds a resolved principal may be served from cache per token. */
  cacheTtlSeconds: number;
}
