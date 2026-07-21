import type { MemoryStatus } from './memory';

/**
 * Post-v1 Priority 2 — the in-app "what needs my attention" surface and the
 * dashboard statistics. Both are COMPUTED per Principal over signals the
 * instance already produces (tasks, review queues, approvals, the dreaming
 * digest); only the minimal read-state (last_seen_at + dismissed keys) is
 * materialized. See docs/notes/dashboard-notifications.md and decision 0039.
 *
 * Every item and every number is Principal-scoped through the existing gated
 * reads — nothing crosses a user or an org boundary, and notification text
 * never carries content beyond what the owner may already see.
 */

/** Attention item kinds — each maps to a display group and a deep-link target. */
export type AttentionKind =
  | 'task_overdue'
  | 'task_due_soon'
  | 'task_dormant'
  | 'review_uncertain'
  | 'review_contradicted'
  | 'approval_pending'
  | 'digest_change';

/**
 * The five human-facing groups the dashboard renders the feed under. Derived
 * from `kind` on the client (see web/src/components/attention-model.ts) so the
 * server stays a flat, typed list.
 */
export type AttentionGroup = 'tasks' | 'quiet' | 'review' | 'approvals' | 'overnight';

/** One line in the attention feed. */
export interface AttentionItem {
  /**
   * Stable dedupe/dismiss key — content-free by construction (ids, run id, and
   * a within-run index; never memory text), so persisting a dismissal never
   * writes memory content to a durable row.
   */
  key: string;
  kind: AttentionKind;
  /** Human-phrased, one line. Only what the owner may already see. */
  title: string;
  /** ISO timestamp the item became relevant — drives unread and ordering. */
  timestamp: string;
  /** Deep link to the object or filtered view behind the item. */
  href: string;
  /** Aggregate count for count-style items (review, approvals); absent otherwise. */
  count?: number;
  /** Whether the user may dismiss this item individually — digest lines only. */
  dismissible: boolean;
  /** True when `timestamp` is newer than the caller's last_seen_at. */
  unread: boolean;
}

/** GET /api/attention — the computed feed plus the honest unread state. */
export interface AttentionFeedDto {
  items: AttentionItem[];
  /** Count of unread, non-dismissed items — the nav/dashboard indicator. */
  unreadCount: number;
  /** When the caller last viewed the surface (null before the first view). */
  lastSeenAt: string | null;
}

/** POST /api/attention/seen — clears the unread indicator (returns the new mark). */
export interface AttentionSeenDto {
  lastSeenAt: string;
}

/** POST /api/attention/dismiss — per-item dismissal (digest lines only). */
export interface AttentionDismissRequest {
  key: string;
}
export interface AttentionDismissDto {
  dismissed: boolean;
}

/** Gated memory counts by lifecycle status — the "memory by status" visual. */
export type MemoryStatusCounts = Record<MemoryStatus, number>;

/** Owner-scoped task counts — open vs blocked vs done vs dismissed. */
export interface TaskStatusCounts {
  open: number;
  blocked: number;
  done: number;
  dismissed: number;
}

/** One UTC day in a bounded daily series. `date` is `YYYY-MM-DD`. */
export interface DailyPoint {
  date: string;
  /** Per-family counts for the day (e.g. { notes, email, files } or { merges, conflicts }). */
  counts: Record<string, number>;
}

/** A bounded daily series over the last `days` UTC days (oldest → newest). */
export interface DailySeries {
  days: number;
  /** The family keys present in `series`, in display order. */
  keys: string[];
  series: DailyPoint[];
}

/** GET /api/dashboard/stats — cheap, gated aggregates for the redesigned home. */
export interface DashboardStatsDto {
  memoryByStatus: MemoryStatusCounts;
  memoryTotal: number;
  tasks: TaskStatusCounts;
  /** Distinct sources ingested per UTC day, grouped into notes / email / files. */
  sources: DailySeries;
  /** Dreaming consolidation activity per UTC day (merges, conflicts caught). */
  dreaming: DailySeries;
  review: {
    uncertain: number;
    contradicted: number;
    /** Oldest unresolved review item (uncertain fact or open contradiction), or null. */
    oldestAt: string | null;
  };
  approvalsPending: number;
}
