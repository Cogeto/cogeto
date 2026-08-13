// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../auth/oidc';
import { initI18n } from '../i18n';

/**
 * The first-run state: no model provider configured (deployment-readiness
 * remediation). The shell tells the operator what to do instead of the pages
 * failing mysteriously.
 *
 *   banner_names_the_fix       — an admin sees the banner with a working link
 *     to /providers.
 *   banner_without_a_dead_link — a non-admin gets "ask your administrator",
 *     never a link their role cannot use.
 *   banner_absent_when_configured — a configured instance renders no banner.
 */

const session = { accessToken: 'test' } as Session;

let configured = false;
let isAdmin = true;
vi.mock('../api', () => ({
  fetchMe: async () => ({ userId: 'u1', orgId: 'o1', name: 'Ana', isAdmin }),
  fetchContradictions: async () => [],
  fetchPendingApprovals: async () => [],
  fetchAttention: async () => ({ unreadCount: 0 }),
  fetchModelConfig: async () => ({
    configured,
    configurationId: configured ? 'mistral-default' : 'unconfigured',
  }),
}));

const { Shell } = await import('./Shell');

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

await initI18n('en');

async function renderShell(): Promise<string> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Shell session={session} title="Chat" active="chat">
          <p>content</p>
        </Shell>
      </QueryClientProvider>,
    );
  });
  // Let the mocked queries settle and re-render.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const html = host.innerHTML;
  await act(async () => root.unmount());
  host.remove();
  return html;
}

describe('first_run_banner', () => {
  it('banner_names_the_fix: an admin sees the explanation and the link to Providers', async () => {
    configured = false;
    isAdmin = true;
    const html = await renderShell();
    expect(html).toContain('No model provider is configured');
    expect(html).toContain('href="/providers"');
    expect(html).toContain('Configure a provider');
  });

  it('banner_without_a_dead_link: a non-admin is told to ask their administrator', async () => {
    configured = false;
    isAdmin = false;
    const html = await renderShell();
    expect(html).toContain('No model provider is configured');
    expect(html).toContain('Ask your administrator');
    expect(html).not.toContain('href="/providers"');
  });

  it('banner_absent_when_configured: a configured instance renders no first-run chrome', async () => {
    configured = true;
    isAdmin = true;
    const html = await renderShell();
    expect(html).not.toContain('No model provider is configured');
  });
});
