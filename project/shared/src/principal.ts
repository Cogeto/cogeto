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
  /** Zitadel organization id — also the tenant / first object-key segment. */
  orgId: string;
  /** Organization display name. */
  orgName: string;
  /** Project role keys granted to the user (empty until roles are defined). */
  roles: string[];
  /**
   * The caller's current SPACE (docs/features/spaces.md): the third hard
   * dimension of the access gate, beside owner and scope. Resolved per
   * request at the identity seam (the `x-cogeto-space` header), and read
   * from the subject row by every worker path that reconstructs a
   * Principal. Absent means the DEFAULT space, which is a real space and
   * never "all spaces": the gates resolve it through
   * {@link resolveSpaceId}, so no query is ever built without the
   * dimension.
   */
  spaceId?: string;
}

/**
 * The default space's fixed, well-known id (migration 0060). A constant so
 * the schema-level column DEFAULT and the code-level fallback name the same
 * row: every pre-spaces row was backfilled into it, and a single-space
 * instance is byte-identical to the product before the feature.
 */
export const DEFAULT_SPACE_ID = '00000000-0000-4000-8000-000000000001';

/** The one resolution of a caller's space: their explicit space, else the
 * default space. Used by both gate constructions, so absence can never mean
 * "all spaces". */
export function resolveSpaceId(principal: Pick<Principal, 'spaceId'>): string {
  return principal.spaceId ?? DEFAULT_SPACE_ID;
}

/**
 * GET /api/me — the Principal plus server-computed capability flags the shell
 * needs. `isAdmin` reflects the configured admin role (COGETO_ADMIN_ROLE,
 *) so the SPA never hardcodes a role name; the server-side AdminGuard
 * remains the enforcement — this flag only drives what the UI offers.
 */
export interface MeDto extends Principal {
  isAdmin: boolean;
}
