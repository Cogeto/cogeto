/**
 * Spaces (docs/features/spaces.md): fully sealed partitions of an instance.
 * Data and API contract only in this session; the switcher is a later one.
 */

export interface SpaceDto {
  id: string;
  name: string;
  createdAt: string;
}

/** GET /api/spaces: every space (every instance user sees every space, by
 * owner decision) plus the caller's resolved current space — their last used
 * space, falling back to the default space. */
export interface SpaceListDto {
  spaces: SpaceDto[];
  currentSpaceId: string;
}

/** The request header carrying the caller's current space. Absent means the
 * default space; a malformed value is refused. */
export const SPACE_HEADER = 'x-cogeto-space';

/**
 * GET /api/spaces/:id/deletion-plan and the DELETE response (session 2): what
 * deleting the space WOULD erase, the numbers the confirmation surface
 * states. Sources are erased through the ordinary deletion saga, one receipt
 * per source; containers are the space-scoped records (projects, aliases,
 * runs, reports, exports, connectors) removed with the partition.
 */
export interface SpaceDeletionPlanDto {
  spaceId: string;
  name: string;
  sources: { sourceType: string; count: number }[];
  totalSources: number;
  containers: { artifact: string; count: number }[];
}

/**
 * A machine caller's per-credential space binding (docs/features/spaces.md
 * section 6c): a machine principal (a token without a human profile) is
 * refused unless an administrator has bound its user id to exactly one
 * space. Managed at PUT/DELETE /api/spaces/machine-bindings/:userId.
 */
export interface MachineSpaceBindingDto {
  userId: string;
  spaceId: string;
  createdAt: string;
  updatedAt: string;
}
