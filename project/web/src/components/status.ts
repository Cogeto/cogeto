import type { MemoryStatus } from '@cogeto/shared';

/** One status → color vocabulary for the whole SPA (list, drawer, chat chips). */
export const STATUS_CHIP: Record<MemoryStatus, string> = {
  active: 'bg-brand-teal/15 text-brand-teal',
  user_approved: 'bg-brand-teal/15 text-brand-teal',
  uncertain: 'bg-amber-100 text-amber-700',
  contradicted: 'bg-red-100 text-red-600',
  outdated: 'bg-slate-200 text-slate-500',
  replaced: 'bg-slate-200 text-slate-500',
};

export const WARN_STATUSES: MemoryStatus[] = ['uncertain', 'contradicted'];

export const statusLabel = (status: MemoryStatus): string => status.replace('_', '-');

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
