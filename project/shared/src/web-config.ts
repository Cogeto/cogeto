/**
 * Response shape of GET /api/config — OIDC parameters the SPA needs to start the
 * PKCE flow. Written by the zitadel-init bootstrap job (§A.2), served by the app.
 */
export interface WebConfig {
  issuer: string;
  clientId: string;
  /**
   * Ana sandbox (decision 0022). Present and true only on a demo instance
   * (`COGETO_DEMO_MODE=1`). The SPA shows the sandbox banner + first-visit
   * overlay.
   */
  demoMode?: boolean;
  /**
   * Password-gated sandbox login (decision 0027, revising 0022 ruling 1). True
   * on a demo instance once the seed has provisioned credentials: the SPA shows
   * a demo login form (username + generated password, printed to the operator by
   * the seed/reset job) and exchanges them at POST /api/config/demo-login for the
   * session — the token is NEVER published on this endpoint. The sandbox is no
   * longer auto-open.
   */
  demoLogin?: boolean;
}
