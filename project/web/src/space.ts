import type { SpaceListDto } from '@cogeto/shared';

/**
 * The caller's current space (docs/features/spaces.md section 3).
 *
 * One module-level binding, set exactly once per page load from
 * GET /api/spaces before any page renders (the App boot gate), and read by
 * the one header builder in api.ts so EVERY request names the space it acts
 * in. Switching spaces persists the choice server-side and then reloads the
 * page: navigation in this SPA is full page loads already, and a reload is
 * the one mechanism that guarantees no query, no badge and no component
 * state can ever briefly show the previous space.
 */

let boundSpaceId: string | null = null;

/** Bind the space every request in this page load acts in. Called once, by
 * the boot fetch; a later rebind is refused so a background refetch of the
 * spaces list can never silently move the session mid-page. */
export function bindCurrentSpace(list: SpaceListDto): void {
  if (boundSpaceId === null) boundSpaceId = list.currentSpaceId;
}

/** The bound space id, or null before the boot fetch resolved (only the boot
 * gate itself and unauthenticated calls run that early). */
export function currentSpaceId(): string | null {
  return boundSpaceId;
}

/** True once the boot fetch bound a space and the app may render pages. */
export function spaceBound(): boolean {
  return boundSpaceId !== null;
}
