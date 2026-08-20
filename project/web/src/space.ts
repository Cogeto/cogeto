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

/** Test seam only: a page load never unbinds. */
export function resetSpaceBindingForTests(): void {
  boundSpaceId = null;
}

/** How long a committed space change waits for its navigation to land before
 * retrying with a reload. Generous: a slow network must not double-navigate. */
export const SPACE_NAV_STALL_MS = 8000;

/** Injectable browser edges, so the machinery is testable in jsdom (which
 * implements no navigation). Production callers pass nothing. */
export interface SpaceNavHooks {
  navigate?: (url: string) => void;
  reload?: () => void;
  schedule?: (fn: () => void, ms: number) => void;
}

let testNavHooks: SpaceNavHooks | null = null;

/** Test seam only: lets a component-initiated commitSpaceChange be observed
 * in jsdom, whose location cannot navigate. Pass null to clear. */
export function setSpaceNavHooksForTests(hooks: SpaceNavHooks | null): void {
  testNavHooks = hooks;
}

/**
 * Leave this page for `path` after a space change was PERSISTED
 * (docs/features/spaces.md section 3; verification F8). The one helper for
 * every initiation — the switcher, create, the deleted-space dialog, the
 * space deletion — so the mechanics can never diverge again:
 *
 * - Query params are never carried: they name objects of the space being
 *   left, and every caller navigates to a bare path.
 * - An opaque full-viewport status covers the page IMMEDIATELY, so nothing
 *   of the previous space stays visible or interactive between the persist
 *   and the reload. This is what closes F8's divergence: the persisted
 *   choice and the visible page can no longer disagree while the user keeps
 *   working, because there is no page to keep working in.
 * - If the navigation never lands (the user hit Stop, the network dropped
 *   mid-switch), the page RETRIES with a reload instead of quietly resuming
 *   under the old binding. Offline, the retry surfaces the browser's own
 *   error page, which is honest; what never happens is an interactive page
 *   whose binding disagrees with the persisted choice.
 */
export function commitSpaceChange(path: string, message: string, hooks: SpaceNavHooks = {}): void {
  const navigate =
    hooks.navigate ?? testNavHooks?.navigate ?? ((url: string) => window.location.assign(url));
  const reload = hooks.reload ?? testNavHooks?.reload ?? (() => window.location.reload());
  const schedule =
    hooks.schedule ??
    testNavHooks?.schedule ??
    ((fn: () => void, ms: number) => window.setTimeout(fn, ms));
  const cover = document.createElement('div');
  cover.setAttribute('role', 'status');
  cover.setAttribute('aria-live', 'polite');
  cover.setAttribute('data-space-nav-cover', '');
  cover.textContent = message;
  cover.className =
    'fixed inset-0 z-[100] grid place-items-center bg-surface text-sm text-slate-600';
  document.body.append(cover);
  navigate(path);
  schedule(reload, SPACE_NAV_STALL_MS);
}

/**
 * The back/forward-cache guard (verification F4). This SPA's whole isolation
 * story rests on "the space is bound once per page load"; a page RESTORED
 * from the back/forward cache is not a page load — the old JS heap resumes,
 * `boundSpaceId` still holds the space the user was in before, and the
 * 30-second polls would quietly resume under the old header while the
 * persisted choice names the new space. On a persisted pageshow the document
 * is hidden in the same task (so the restored snapshot cannot become an
 * interactive wrong-space view, not even for the polls' first tick) and the
 * page reloads, which re-runs the boot gate and rebinds. Installed once by
 * main.tsx, before anything renders.
 */
export function installBfcacheGuard(reload: () => void = () => window.location.reload()): void {
  window.addEventListener('pageshow', (event) => {
    if (!(event as PageTransitionEvent).persisted) return;
    document.documentElement.style.visibility = 'hidden';
    reload();
  });
}
