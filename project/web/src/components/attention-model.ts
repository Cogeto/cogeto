import type { AttentionGroup, AttentionItem, AttentionKind } from '@cogeto/shared';

/**
 * Pure presentation model for the attention surface (Post-v1 Priority 2). Kept
 * free of React/DOM so it is unit-tested directly (attention-model.spec.ts):
 * grouping, per-group unread counts, and the icon/label vocabulary that makes
 * every item carry a NON-COLOR signal (a glyph + text), never color alone.
 */

export interface GroupMeta {
  key: AttentionGroup;
  /** Human section heading. */
  label: string;
  /** A glyph — the non-color group signal (aria-hidden; the label carries meaning). */
  icon: string;
}

/** Which display group each kind belongs to. */
const KIND_GROUP: Record<AttentionKind, AttentionGroup> = {
  task_overdue: 'tasks',
  task_due_soon: 'tasks',
  task_dormant: 'quiet',
  review_uncertain: 'review',
  review_contradicted: 'review',
  approval_pending: 'approvals',
  digest_change: 'overnight',
};

/** Display order of the groups — most-pressing first. */
export const GROUP_ORDER: AttentionGroup[] = ['tasks', 'quiet', 'review', 'approvals', 'overnight'];

export const GROUP_META: Record<AttentionGroup, GroupMeta> = {
  tasks: { key: 'tasks', label: 'Due & overdue', icon: '◷' },
  quiet: { key: 'quiet', label: 'Gone quiet', icon: '☾' },
  review: { key: 'review', label: 'Waiting on your review', icon: '?' },
  approvals: { key: 'approvals', label: 'Awaiting your approval', icon: '✓' },
  overnight: { key: 'overnight', label: 'Last night', icon: '✦' },
};

/** Per-kind glyph — every item shows this, so meaning never rides on color. */
export const KIND_ICON: Record<AttentionKind, string> = {
  task_overdue: '⚠',
  task_due_soon: '◷',
  task_dormant: '☾',
  review_uncertain: '?',
  review_contradicted: '⚠',
  approval_pending: '✓',
  digest_change: '✦',
};

export function groupOf(kind: AttentionKind): AttentionGroup {
  return KIND_GROUP[kind];
}

export interface AttentionGroupView {
  group: GroupMeta;
  items: AttentionItem[];
  /** Unread items in this group — drives the small per-section dot. */
  unread: number;
}

/** Fold a flat, server-ordered feed into ordered display groups. */
export function groupItems(items: AttentionItem[]): AttentionGroupView[] {
  const byGroup = new Map<AttentionGroup, AttentionItem[]>();
  for (const item of items) {
    const g = KIND_GROUP[item.kind];
    byGroup.set(g, [...(byGroup.get(g) ?? []), item]);
  }
  return GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => {
    const groupItems = byGroup.get(g)!;
    return {
      group: GROUP_META[g],
      items: groupItems,
      unread: groupItems.filter((i) => i.unread).length,
    };
  });
}

/** The four render states of an async surface — one selector, testable + shared. */
export type SurfaceState = 'loading' | 'error' | 'empty' | 'ready';

export function surfaceState(query: {
  isPending: boolean;
  isError: boolean;
  isEmpty: boolean;
}): SurfaceState {
  if (query.isPending) return 'loading';
  if (query.isError) return 'error';
  if (query.isEmpty) return 'empty';
  return 'ready';
}

/** Client-side sanity allowlist for a deep-link target (defense in depth). */
const ROUTE_PREFIXES = ['/tasks', '/review', '/approvals', '/memories'];
export function isKnownRoute(href: string): boolean {
  return ROUTE_PREFIXES.some((p) => href === p || href.startsWith(`${p}?`));
}
