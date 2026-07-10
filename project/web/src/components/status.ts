import type { MemoryStatus } from '@cogeto/shared';

/**
 * The status vocabulary for the whole SPA (O3-C). Status is load-bearing
 * information, so each of the six lifecycle states gets an AA-contrast color
 * (verified: 5.3–6.9:1) AND a distinct label + icon — never color alone, and
 * colorblind-distinguishable (active vs approved, outdated vs replaced differ by
 * icon+label, not just hue). Rendered through one canonical <StatusChip>.
 */
export interface StatusMeta {
  /** Human label (approved, not user-approved). */
  label: string;
  /** A short glyph, redundant with the label — decorative (aria-hidden). */
  icon: string;
  /** `bg + text` utility classes, AA-verified. */
  className: string;
}

export const STATUS_META: Record<MemoryStatus, StatusMeta> = {
  active: { label: 'active', icon: '●', className: 'bg-brand-teal-surface text-brand-teal-ink' },
  user_approved: {
    label: 'approved',
    icon: '✓',
    className: 'bg-brand-teal-surface text-brand-teal-ink',
  },
  uncertain: { label: 'uncertain', icon: '?', className: 'bg-amber-100 text-amber-800' },
  contradicted: { label: 'contradicted', icon: '⚠', className: 'bg-red-100 text-red-700' },
  outdated: { label: 'outdated', icon: '○', className: 'bg-slate-100 text-slate-600' },
  replaced: { label: 'replaced', icon: '↻', className: 'bg-slate-100 text-slate-600' },
};

/** Kept for any direct className consumer; prefer the <StatusChip> component. */
export const STATUS_CHIP: Record<MemoryStatus, string> = Object.fromEntries(
  Object.entries(STATUS_META).map(([k, v]) => [k, v.className]),
) as Record<MemoryStatus, string>;

export const WARN_STATUSES: MemoryStatus[] = ['uncertain', 'contradicted'];

/** Muted chip for past-belief facts in chat (F3-A, decision 0012 ruling 6). */
export const PAST_CHIP = 'bg-slate-100 text-slate-600 border border-slate-300';

export const statusLabel = (status: MemoryStatus): string => STATUS_META[status].label;

/**
 * Tone vocabulary for the adjacent, non-memory-status chips (health up/down,
 * file-processing state, verification verdict, worker liveness). Same AA palette
 * so the whole app reads as one system.
 */
export type Tone = 'positive' | 'warning' | 'danger' | 'neutral' | 'info';

export const TONE_CLASS: Record<Tone, string> = {
  positive: 'bg-brand-teal-surface text-brand-teal-ink',
  warning: 'bg-amber-100 text-amber-800',
  danger: 'bg-red-100 text-red-700',
  neutral: 'bg-slate-100 text-slate-600',
  info: 'bg-violet-100 text-violet-700',
};

/** Past belief, client-side twin: replaced/outdated or interval closed. */
export function isPastFact(status: MemoryStatus, validUntil: string | null): boolean {
  if (status === 'replaced' || status === 'outdated') return true;
  return validUntil !== null && new Date(validUntil).getTime() <= Date.now();
}

/**
 * Relative due rendering for task rows (F3 handoff §4): "in 3 days", "due
 * today", "overdue by 2 days". `overdue` drives the red treatment.
 */
export function dueLabel(iso: string): { text: string; overdue: boolean } {
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days < 0) {
    const n = -days;
    return { text: `overdue by ${n === 1 ? '1 day' : `${n} days`}`, overdue: true };
  }
  if (days === 0) return { text: 'due today', overdue: false };
  return { text: days === 1 ? 'due tomorrow' : `in ${days} days`, overdue: false };
}

/** Relative timestamp for list rows; exact date on hover via title attr. */
export function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(iso).toLocaleDateString();
}
