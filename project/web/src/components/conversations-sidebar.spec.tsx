// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import type { ConversationDto } from '@cogeto/shared';
import type { Session } from '../auth/oidc';
import {
  chatLink,
  conversationLabel,
  conversationPreview,
  deleteConversationConfirm,
  initialConversationId,
  parseChatLink,
  splitConversations,
} from './conversations-model';
import { ConversationSidebar } from './ConversationSidebar';
import { ConfirmProvider } from './confirm';

/**
 * The conversations sidebar
 *
 *   sidebar_lifecycle — create/rename/archive/switch states are correct in the
 *     model (labels, previews, the active/archived split, next selection after
 *     deletion) and the rendered sidebar marks the active thread and collapses
 *     the archived section.
 *   deep_links_open_conversation — /chat?c=<conversation>&m=<message> parses,
 *     round-trips, and wins over recency when choosing the open conversation.
 *   delete_confirm_counts — the confirm dialog's text carries the preview's
 *     exact numbers, calls out user-approved memories, and
 *     names archive as the safe alternative.
 *   sidebar_a11y — axe passes on the rendered sidebar.
 */

const conv = (over: Partial<ConversationDto> & Pick<ConversationDto, 'id'>): ConversationDto => ({
  title: null,
  titleSetByUser: false,
  archived: false,
  createdAt: new Date(Date.now() - 86_400_000).toISOString(),
  updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
  lastMessagePreview: null,
  projectId: null,
  ...over,
});

const FIXTURE: ConversationDto[] = [
  conv({
    id: 'c-active',
    title: 'Adriatic proposal prep',
    lastMessagePreview: 'What did I promise them about the CRM mapping?',
  }),
  conv({ id: 'c-new', lastMessagePreview: null }),
  conv({ id: 'c-archived', title: 'Old quarter planning', archived: true }),
];

const session = { accessToken: 'test-token' } as Session;
const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
queryClient.setQueryData(['conversations'], FIXTURE);
const noop = () => undefined;
const html = renderToStaticMarkup(
  <QueryClientProvider client={queryClient}>
    {/* The rail's delete asks through useConfirm() now (issue #528), so the
        provider is part of rendering it at all. */}
    <ConfirmProvider>
      <ConversationSidebar
        session={session}
        activeId="c-active"
        onSelect={noop}
        onCreated={noop}
        onDeleted={noop}
      />
    </ConfirmProvider>
  </QueryClientProvider>,
);

describe('sidebar_lifecycle', () => {
  it('labels: a titled thread shows its title; an untitled one shows the placeholder', () => {
    expect(conversationLabel(FIXTURE[0]!)).toBe('Adriatic proposal prep');
    expect(conversationLabel(FIXTURE[1]!)).toBe('New conversation');
  });

  it('previews flatten and clamp the last message', () => {
    expect(conversationPreview(FIXTURE[0]!)).toBe('What did I promise them about the CRM mapping?');
    expect(
      conversationPreview(conv({ id: 'x', lastMessagePreview: `a\n${'b'.repeat(100)}` })),
    ).toMatch(/^a b+…$/);
    expect(conversationPreview(FIXTURE[1]!)).toBeNull();
  });

  it('splits active from archived, preserving the served recency order', () => {
    const { active, archived } = splitConversations(FIXTURE);
    expect(active.map((c) => c.id)).toEqual(['c-active', 'c-new']);
    expect(archived.map((c) => c.id)).toEqual(['c-archived']);
  });

  it('after deleting the active thread, selection falls to the most recent remaining', () => {
    const remaining = FIXTURE.filter((c) => c.id !== 'c-active');
    expect(initialConversationId(remaining, null)).toBe('c-new');
    expect(initialConversationId([], null)).toBeNull();
  });

  it('renders the active thread marked, the archived section collapsed, and the continuity sentence once', () => {
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('Adriatic proposal prep');
    expect(html).toContain('New conversation');
    expect(html).toContain('Archived (1)');
    expect(html).not.toContain('Old quarter planning'); // collapsed until opened
    const continuity = html.match(/What Cogeto learns here is remembered everywhere/g);
    expect(continuity).toHaveLength(1);
  });

  it('no product copy carries typographic dashes', () => {
    expect(html).not.toMatch(/[–—]/);
  });
});

describe('deep_links_open_conversation', () => {
  it('parses /chat?c=<conversation>&m=<message> and round-trips through chatLink', () => {
    const link = chatLink('c-active', 'msg-1');
    const parsed = parseChatLink(new URL(`https://x.test${link}`).search);
    expect(parsed).toEqual({ conversationId: 'c-active', messageId: 'msg-1' });
    expect(parseChatLink('')).toEqual({ conversationId: null, messageId: null });
  });

  it('a deep-linked conversation wins over recency; an unknown one falls back', () => {
    expect(initialConversationId(FIXTURE, 'c-archived')).toBe('c-archived');
    expect(initialConversationId(FIXTURE, 'c-gone')).toBe('c-active');
    expect(initialConversationId(FIXTURE, null)).toBe('c-active');
  });
});

describe('delete_confirm_counts', () => {
  it('states the exact consequence with the preview numbers and the archive alternative', () => {
    const request = deleteConversationConfirm('Adriatic proposal prep', {
      memoryCount: 4,
      messageCount: 12,
      userApprovedCount: 1,
    });
    expect(request.title).toContain('Adriatic proposal prep');
    expect(request.consequence).toContain('its 12 messages');
    expect(request.consequence).toContain('the 4 memories derived from them');
    expect(request.consequence).toContain('signed receipt');
    // The blessed memories are their OWN field now (issue #528), so the
    // dialog gives them weight instead of burying them in a paragraph.
    expect(request.note).toContain('1 of those memories was approved by you');
    expect(request.alternative).toContain('Archiving keeps everything instead');
    expect(request.destructive).toBe(true);
  });

  it('omits the knowing-deletion note when nothing approved is affected', () => {
    const request = deleteConversationConfirm('Quick questions', {
      memoryCount: 0,
      messageCount: 2,
      userApprovedCount: 0,
    });
    expect(request.consequence).toContain('its 2 messages');
    expect(request.consequence).toContain('the 0 memories');
    expect(request.note).toBeUndefined();
  });
});

describe('sidebar_a11y', () => {
  it('axe passes on the rendered sidebar', async () => {
    const host = document.createElement('main');
    host.innerHTML = html;
    document.body.appendChild(host);
    try {
      const results = await axe.run(host);
      const summary = results.violations
        .map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`)
        .join('\n');
      expect(results.violations, summary).toEqual([]);
    } finally {
      host.remove();
    }
  });
});

/**
 * projects_reachable_from_zero (issue #579).
 *
 * The create row was rendered only when the rail was already GROUPED, and the
 * rail groups only once a project exists. The one affordance that makes a
 * project was therefore hidden until you had one, so on a fresh instance the
 * feature could not be reached from the interface at all. Reported from a
 * deployed v1.7.2 instance, where there was no button to find.
 *
 * The empty state is the whole test: with no projects the rail must still be
 * the flat list it was before the feature (no sections), AND it must offer the
 * way in.
 */
describe('projects_reachable_from_zero', () => {
  const zeroProjects = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  zeroProjects.setQueryData(['conversations'], FIXTURE);
  zeroProjects.setQueryData(['projects'], []);
  const emptyHtml = renderToStaticMarkup(
    <QueryClientProvider client={zeroProjects}>
      <ConfirmProvider>
        <ConversationSidebar
          session={session}
          activeId="c-active"
          onSelect={noop}
          onCreated={noop}
          onDeleted={noop}
        />
      </ConfirmProvider>
    </QueryClientProvider>,
  );

  it('offers the way in when no project exists yet', () => {
    expect(emptyHtml).toContain('New project');
    expect(emptyHtml).toContain('Projects');
  });

  it('still shows the flat list: an instance that ignores projects sees no sections', () => {
    // Inert by default, kept in the interface as well as in retrieval: the
    // heading and its create row are the empty state, not a workspace.
    expect(emptyHtml).not.toContain('No project');
    expect(emptyHtml).toContain('Adriatic proposal prep');
  });
});
