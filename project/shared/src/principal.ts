/**
 * The authenticated principal returned by the identity seam (docs/glossary.md).
 * Zitadel asserts who/org/roles; memory scoping is Cogeto's own logic (scope §4.5).
 */
export interface Principal {
  /** Zitadel user id (`sub`). */
  userId: string;
  /** Display name. */
  name: string;
  /** Primary email, when the profile scope provides one. */
  email: string | null;
  /** Zitadel organization id — also the tenant / first object-key segment (§A.6). */
  orgId: string;
  /** Organization display name. */
  orgName: string;
  /** Project role keys granted to the user (empty until roles are defined). */
  roles: string[];
}

/**
 * GET /api/me — the Principal plus server-computed capability flags the shell
 * needs. `isAdmin` reflects the configured admin role (COGETO_ADMIN_ROLE,
 * QS-10) so the SPA never hardcodes a role name; the server-side AdminGuard
 * remains the enforcement — this flag only drives what the UI offers.
 */
export interface MeDto extends Principal {
  isAdmin: boolean;
}
