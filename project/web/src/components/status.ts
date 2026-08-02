import type { MemoryStatus } from '@cogeto/shared';
import { i18next } from '../i18n';

/**
 * The status vocabulary for the whole SPA. Status is load-bearing
 * information, so each of the six lifecycle states gets an AA-contrast color
 * (verified: 5.3–6.9:1) AND a distinct label + icon — never color alone, and
 * colorblind-distinguishable (active vs approved, outdated vs replaced differ by
 * icon+label, not just hue). Rendered through one canonical <StatusChip>.
 *
 * The six values are the ENUM (spec §3): they travel to and from the API and
 * are never translated. Only their DISPLAY NAMES are, through
 * `common:memoryStatus.<value>` (V2.0 item 3.5). The map from value to key is
 * explicit and lives here; no call site builds a label from a value by hand.
 */
export interface StatusMeta {
  /** A short glyph, redundant with the label — decorative (aria-hidden). */
  icon: string;
  /** `bg + text` utility classes, AA-verified. */
  className: string;
}

// Dark variants tint each hue over the dark surface and lift the ink to a
// light shade of the same hue, so every chip keeps AA contrast and its colorblind
// distinctness (label + icon still carry the meaning). The neutral (slate) chips
// need no dark: variant — the slate ramp remaps under:root.dark automatically.
export const STATUS_META: Record<MemoryStatus, StatusMeta> = {
  active: {
    icon: '●',
    className:
      'bg-brand-teal-surface text-brand-teal-ink dark:bg-brand-teal/15 dark:text-brand-teal',
  },
  user_approved: {
    icon: '✓',
    className:
      'bg-brand-teal-surface text-brand-teal-ink dark:bg-brand-teal/15 dark:text-brand-teal',
  },
  uncertain: {
    icon: '?',
    className: 'bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300',
  },
  contradicted: {
    icon: '⚠',
    className: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  },
  outdated: { icon: '○', className: 'bg-slate-100 text-slate-600' },
  replaced: { icon: '↻', className: 'bg-slate-100 text-slate-600' },
};

export const WARN_STATUSES: MemoryStatus[] = ['uncertain', 'contradicted'];

/** Muted chip for past-belief facts in chat. */
export const PAST_CHIP = 'bg-slate-100 text-slate-600 border border-slate-300';

/** The translated display name of a lifecycle status. Never the stored value. */
export const statusLabel = (status: MemoryStatus): string =>
  i18next.t(`common:memoryStatus.${status}`);

/**
 * Tone vocabulary for the adjacent, non-memory-status chips (health up/down,
 * file-processing state, verification verdict, worker liveness). Same AA palette
 * so the whole app reads as one system.
 */
export type Tone = 'positive' | 'warning' | 'danger' | 'neutral' | 'info';

export const TONE_CLASS: Record<Tone, string> = {
  positive: 'bg-brand-teal-surface text-brand-teal-ink dark:bg-brand-teal/15 dark:text-brand-teal',
  warning: 'bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300',
  danger: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  neutral: 'bg-slate-100 text-slate-600',
  info: 'bg-violet-100 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300',
};

/** Past belief, client-side twin: replaced/outdated or interval closed. */
export function isPastFact(status: MemoryStatus, validUntil: string | null): boolean {
  if (status === 'replaced' || status === 'outdated') return true;
  return validUntil !== null && new Date(validUntil).getTime() <= Date.now();
}

/**
 * Relative timestamp for list rows; exact date on hover via title attr.
 * Re-exported from the shared formatting helper so every call site goes through
 * one locale-aware implementation (V2.0 item 3.5, Issue C).
 */
export { formatRelativeTime as timeAgo } from '../i18n/format';
