/**
 * Response shape of GET /api/config — OIDC parameters the SPA needs to start the
 * PKCE flow. Written by the zitadel-init bootstrap job (§A.2), served by the app.
 */
export interface WebConfig {
  issuer: string;
  clientId: string;
}
