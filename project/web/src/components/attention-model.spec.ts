import { describe, expect, it } from 'vitest';
import type { AttentionItem, AttentionKind } from '@cogeto/shared';
import {
  GROUP_META,
  GROUP_ORDER,
  KIND_ICON,
  groupItems,
  groupOf,
  isKnownRoute,
  surfaceState,
} from './attention-model';

const ALL_KINDS: AttentionKind[] = [
  'task_overdue',
  'task_due_soon',
  'task_dormant',
  'review_uncertain',
  'review_contradicted',
  'approval_pending',
  'digest_change',
];

const item = (kind: AttentionKind, over: Partial<AttentionItem> = {}): AttentionItem => ({
  key: `${kind}-${over.key ?? '1'}`,
  kind,
  title: `A ${kind} item`,
  timestamp: '2026-07-20T00:00:00.000Z',
  href: '/tasks',
  dismissible: kind === 'digest_change',
  unread: false,
  ...over,
});

describe('attention-model', () => {
  it('no_color_only: every kind carries a glyph and a labelled group', () => {
    for (const kind of ALL_KINDS) {
      expect(KIND_ICON[kind]).toBeTruthy();
      const group = GROUP_META[groupOf(kind)];
      expect(group.label.length).toBeGreaterThan(0);
      expect(group.icon).toBeTruthy();
    }
  });

  it('groups items in the fixed display order with per-group unread counts', () => {
    const items = [
      item('digest_change', { href: '/memories?open=1', unread: true }),
      item('task_overdue', { unread: true }),
      item('review_uncertain', { href: '/review', count: 3 }),
      item('task_due_soon'),
    ];
    const groups = groupItems(items);
    // tasks (overdue + due_soon) comes before review, which comes before overnight.
    expect(groups.map((g) => g.group.key)).toEqual(['tasks', 'review', 'overnight']);
    expect(groups[0]!.items).toHaveLength(2);
    expect(groups[0]!.unread).toBe(1); // only the overdue one is unread
    expect(groups.every((g) => GROUP_ORDER.includes(g.group.key))).toBe(true);
  });

  it('surfaceState selects loading → error → empty → ready in priority order', () => {
    expect(surfaceState({ isPending: true, isError: true, isEmpty: true })).toBe('loading');
    expect(surfaceState({ isPending: false, isError: true, isEmpty: true })).toBe('error');
    expect(surfaceState({ isPending: false, isError: false, isEmpty: true })).toBe('empty');
    expect(surfaceState({ isPending: false, isError: false, isEmpty: false })).toBe('ready');
  });

  it('deep_links_resolve: every server-emitted attention target is a known route', () => {
    const emitted = [
      '/tasks',
      '/review',
      '/review?tab=contradicted',
      '/approvals',
      '/memories',
      '/memories?open=abc',
      '/memories?status=outdated',
    ];
    for (const href of emitted) expect(isKnownRoute(href)).toBe(true);
    expect(isKnownRoute('/evil')).toBe(false);
    expect(isKnownRoute('https://example.com')).toBe(false);
  });
});
