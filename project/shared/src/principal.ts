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
