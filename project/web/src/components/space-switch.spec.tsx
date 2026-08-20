// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpaceListDto } from '@cogeto/shared';
import type { Session } from '../auth/oidc';
import { bindCurrentSpace, resetSpaceBindingForTests, setSpaceNavHooksForTests } from '../space';

/**
 * The space switch machinery (docs/features/spaces.md section 3;
 * verification F8's coverage gap). This is the single most used interaction
 * in the feature, and it had no coverage at all, which is exactly why the
 * back/forward-cache defect went unnoticed. What these tests hold:
 *
 *   switch_commits_and_recomputes_everything — picking a space persists the
 *     choice, then leaves the page through the committed-change mechanics:
 *     the page is covered (so no badge or list of the previous space stays
 *     visible or interactive; the reload is what recomputes every surface),
 *     the navigation drops query params (they name objects of the space
 *     being left), and NO cache is mutated optimistically, so a badge can
 *     never briefly show the previous space's figures.
 *   failed_switch_stays_put_and_says_so — a switch the server refused leaves
 *     the user exactly where they were: no navigation, no cover, and an
 *     alert naming the space they are still in.
 *   deleted_space_resolves_gracefully — a space deleted in another session
 *     surfaces as a deliberate dialog (never a quietly empty view), whose
 *     one action leaves through the same committed mechanics; a live space
 *     shows no dialog.
 *   sign_out_is_rendered — the avatar menu really renders Sign out (restores
 *     the rendered assertion the session-3 nav redesign downgraded to a
 *     source-text grep, verification F13).
 */

const putCurrentSpace = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('../api', () => ({
  // The error translator narrows on this class; the failure test throws a
  // plain Error, which falls to the generic message either way.
  ApiError: class extends Error {
    code?: string;
  },
  fetchSpaces: async (): Promise<SpaceListDto> => LIST,
  putCurrentSpace: (...args: unknown[]) => putCurrentSpace(...args),
  createSpace: async () => ({ id: 'space-new', name: 'New', createdAt: NOW }),
  renameSpace: async () => ({}),
  fetchMe: async () => ({ name: 'Ana', orgName: 'Org', isAdmin: true }),
  fetchContradictions: async () => [],
  fetchPendingApprovals: async () => [],
  fetchAttention: async () => ({ unreadCount: 0, items: [] }),
  fetchModelConfig: async () => ({ configured: true }),
}));

const { SpaceSwitcher } = await import('./SpaceSwitcher');
const { Shell } = await import('./Shell');
const { UserMenu } = await import('./UserMenu');

// React's own act-environment flag; without it every act() warns.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date().toISOString();
const LIST: SpaceListDto = {
  spaces: [
    { id: 'space-a', name: 'Alpha', createdAt: NOW },
    { id: 'space-b', name: 'Beta', createdAt: NOW },
  ],
  currentSpaceId: 'space-a',
};
const session = { accessToken: 'test-token' } as Session;

function freshClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(['spaces'], LIST);
  client.setQueryData(['me'], { name: 'Ana', orgName: 'Org', isAdmin: true });
  client.setQueryData(['contradictions'], []);
  client.setQueryData(['pending-approvals'], []);
  client.setQueryData(['attention'], { unreadCount: 3, items: [] });
  client.setQueryData(['model-config'], { configured: true });
  return client;
}

function mount(ui: React.ReactElement, client = freshClient()) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>));
  return { host, client, unmount: () => act(() => root.unmount()) };
}

const click = (element: Element | null | undefined) =>
  act(() => {
    (element as HTMLElement).click();
  });

const nav = { navigate: vi.fn(), reload: vi.fn(), schedule: vi.fn() };

afterEach(() => {
  vi.clearAllMocks();
  setSpaceNavHooksForTests(null);
  resetSpaceBindingForTests();
  document.body.innerHTML = '';
});

function bindA() {
  bindCurrentSpace(LIST);
  setSpaceNavHooksForTests(nav);
}

const optionFor = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((el) =>
    el.textContent?.includes(name),
  );

describe('switch_commits_and_recomputes_everything', () => {
  it('persists, covers the page, navigates to the bare path, and mutates no cache', async () => {
    bindA();
    putCurrentSpace.mockResolvedValueOnce({ currentSpaceId: 'space-b' });
    window.history.replaceState(null, '', '/sources?open=some-object-key');
    const { host, client } = mount(<SpaceSwitcher session={session} />);

    click(host.querySelector('button[aria-haspopup="listbox"]'));
    await act(async () => undefined);
    click(optionFor(host, 'Beta'));
    await act(async () => undefined);

    expect(putCurrentSpace).toHaveBeenCalledWith(session, 'space-b');
    // The bare path: ?open= names an object of the space being left.
    expect(nav.navigate).toHaveBeenCalledWith('/sources');
    // The cover is up: nothing of Alpha stays visible or interactive, so a
    // badge cannot even briefly show Alpha's figures while Beta loads.
    expect(document.querySelector('[data-space-nav-cover]')).not.toBeNull();
    // No optimistic mutation anywhere: the recompute mechanism is the reload,
    // never a cache write that could disagree with the server.
    expect(client.getQueryData(['spaces'])).toBe(LIST);
    expect(client.getQueryData(['attention'])).toEqual({ unreadCount: 3, items: [] });
  });
});

describe('failed_switch_stays_put_and_says_so', () => {
  it('shows an alert naming the current space; no navigation, no cover', async () => {
    bindA();
    putCurrentSpace.mockRejectedValueOnce(new Error('boom'));
    const { host } = mount(<SpaceSwitcher session={session} />);

    click(host.querySelector('button[aria-haspopup="listbox"]'));
    await act(async () => undefined);
    click(optionFor(host, 'Beta'));
    await act(async () => undefined);

    expect(nav.navigate).not.toHaveBeenCalled();
    expect(document.querySelector('[data-space-nav-cover]')).toBeNull();
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Alpha');
    expect(alert?.textContent).toContain('still in');
  });
});

describe('deleted_space_resolves_gracefully', () => {
  it('a live bound space shows no dialog', () => {
    bindA();
    const { host } = mount(
      <Shell session={session} title="Sources" active="sources">
        <p>content</p>
      </Shell>,
    );
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('a bound space missing from the list raises the dialog, whose action leaves through the committed mechanics', async () => {
    bindCurrentSpace({ ...LIST, currentSpaceId: 'space-gone' });
    setSpaceNavHooksForTests(nav);
    const { host } = mount(
      <Shell session={session} title="Sources" active="sources">
        <p>content</p>
      </Shell>,
    );
    const dialog = host.querySelector('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    click(dialog?.querySelector('button'));
    await act(async () => undefined);
    expect(nav.navigate).toHaveBeenCalledWith('/');
    expect(document.querySelector('[data-space-nav-cover]')).not.toBeNull();
  });
});

describe('sign_out_is_rendered', () => {
  it('the avatar menu renders Sign out', () => {
    const { host } = mount(<UserMenu userName="Ana" orgName="Org" />);
    click(host.querySelector('button'));
    const items = [...host.querySelectorAll('button, a')].map((el) => el.textContent?.trim());
    expect(items).toContain('Sign out');
  });
});
