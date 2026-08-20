// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authHeaders } from './api';
import type { Session } from './auth/oidc';
import {
  bindCurrentSpace,
  commitSpaceChange,
  currentSpaceId,
  installBfcacheGuard,
  resetSpaceBindingForTests,
  SPACE_NAV_STALL_MS,
} from './space';

/**
 * The space binding and navigation machinery (docs/features/spaces.md
 * section 3; verification F4 and F8). This is the layer whose lack of
 * coverage let the back/forward-cache resurrection go unnoticed: every
 * isolation claim the SPA makes rests on "bound once per page load, carried
 * on every request, and no page ever survives a space change".
 *
 *   bind_is_write_once — a later spaces refetch can never silently move the
 *     session mid-page; the first bind wins for the whole page load.
 *   every_request_names_the_space — the ONE header builder carries the bound
 *     space; before the boot gate binds, no space header is sent (the server
 *     then resolves the default space, the documented anchor rule).
 *   bfcache_restore_never_renders_stale — a page restored from the
 *     back/forward cache resumes the OLD heap with the OLD binding; the
 *     guard hides the document in the same task and reloads, so the restored
 *     snapshot can never become an interactive wrong-space view (F4). An
 *     ordinary pageshow (a normal load) does nothing.
 *   committed_change_cannot_be_escaped — after a space change is persisted,
 *     the page is covered by an opaque status, the navigation happens on the
 *     bare path, and a stalled navigation retries with a reload instead of
 *     leaving the old page interactive under a diverged persisted choice
 *     (F8).
 *   guard_is_installed — main.tsx wires the guard before anything renders; a
 *     refactor that drops the call re-opens F4 silently, so the wiring is
 *     pinned.
 */

afterEach(() => {
  resetSpaceBindingForTests();
  document.documentElement.style.visibility = '';
  document.body.innerHTML = '';
});

const list = (current: string) => ({
  spaces: [
    { id: 'space-a', name: 'Space A', createdAt: new Date().toISOString() },
    { id: 'space-b', name: 'Space B', createdAt: new Date().toISOString() },
  ],
  currentSpaceId: current,
});

describe('bind_is_write_once', () => {
  it('keeps the first bound space when a later list would move it', () => {
    bindCurrentSpace(list('space-a'));
    bindCurrentSpace(list('space-b'));
    expect(currentSpaceId()).toBe('space-a');
  });
});

describe('every_request_names_the_space', () => {
  const session = { accessToken: 'test-token' } as Session;

  it('omits the header before the boot gate binds (server resolves the default space)', () => {
    expect(authHeaders(session)).not.toHaveProperty('x-cogeto-space');
  });

  it('carries the bound space on every request after the bind', () => {
    bindCurrentSpace(list('space-b'));
    expect(authHeaders(session)['x-cogeto-space']).toBe('space-b');
  });
});

describe('bfcache_restore_never_renders_stale', () => {
  it('hides the restored snapshot and reloads on a persisted pageshow; a normal pageshow does nothing', () => {
    const reload = vi.fn();
    installBfcacheGuard(reload);

    const normal = new Event('pageshow');
    window.dispatchEvent(normal);
    expect(reload).not.toHaveBeenCalled();
    expect(document.documentElement.style.visibility).toBe('');

    const restored = new Event('pageshow');
    Object.defineProperty(restored, 'persisted', { value: true });
    window.dispatchEvent(restored);
    expect(reload).toHaveBeenCalledTimes(1);
    // Hidden in the same task: the stale view is gone before any poll or
    // click can act under the previous page load's binding.
    expect(document.documentElement.style.visibility).toBe('hidden');
  });
});

describe('committed_change_cannot_be_escaped', () => {
  it('covers the page, navigates to the bare path, and retries with a reload on a stall', () => {
    const navigate = vi.fn();
    const reload = vi.fn();
    const scheduled: { fn: () => void; ms: number }[] = [];
    commitSpaceChange('/sources', 'Switching to Space B…', {
      navigate,
      reload,
      schedule: (fn, ms) => scheduled.push({ fn, ms }),
    });

    const cover = document.querySelector('[data-space-nav-cover]');
    expect(cover).not.toBeNull();
    expect(cover?.getAttribute('role')).toBe('status');
    expect(cover?.textContent).toBe('Switching to Space B…');
    // Opaque and viewport-filling: nothing of the previous space stays
    // visible or clickable between the persist and the reload.
    for (const cls of ['fixed', 'inset-0', 'bg-surface']) {
      expect(cover?.className.split(/\s+/)).toContain(cls);
    }

    expect(navigate).toHaveBeenCalledWith('/sources');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBe(SPACE_NAV_STALL_MS);
    expect(reload).not.toHaveBeenCalled();
    scheduled[0]!.fn();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('guard_is_installed', () => {
  it('main.tsx installs the bfcache guard before rendering anything', () => {
    const main = readFileSync(path.resolve(__dirname, 'main.tsx'), 'utf8');
    expect(main).toContain('installBfcacheGuard()');
  });
});
