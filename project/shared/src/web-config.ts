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
   * overlay and installs `demoSession` instead of showing the login screen.
   */
  demoMode?: boolean;
  /**
   * Pre-minted demo session for the sandbox visitor (decision 0022 ruling 1) —
   * a real Zitadel PAT for the demo Principal. Served on the already-public
   * /api/config only when `demoMode` is true. Undefined until the demo-seed job
   * has provisioned the Principal.
   */
  demoSession?: {
    accessToken: string;
  };
}
