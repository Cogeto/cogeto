import type { ReactNode } from 'react';
import { isDemoSession, logout } from '../auth/oidc';
import { CountBadge } from './ui';

export type NavSection =
  | 'dashboard'
  | 'memories'
  | 'chat'
  | 'research'
  | 'timeline'
  | 'tasks'
  | 'review'
  | 'approvals'
  | 'forgotten'
  | 'audit'
  | 'system'
  | 'settings';

const ENABLED: { key: NavSection; label: string; href: string }[] = [
  { key: 'dashboard', label: 'Dashboard', href: '/' },
  { key: 'memories', label: 'Memories', href: '/memories' },
  { key: 'chat', label: 'Chat', href: '/chat' },
  { key: 'research', label: 'Research', href: '/research' },
  { key: 'timeline', label: 'Time travel', href: '/timeline' },
  { key: 'tasks', label: 'Tasks', href: '/tasks' },
  { key: 'review', label: 'Review', href: '/review' },
  { key: 'approvals', label: 'Approvals', href: '/approvals' },
  { key: 'forgotten', label: 'Forgotten', href: '/forgotten' },
  { key: 'audit', label: 'Audit', href: '/audit' },
  { key: 'system', label: 'System', href: '/system' },
  { key: 'settings', label: 'Settings', href: '/settings' },
];

const BADGE_LABEL: Partial<Record<NavSection, string>> = {
  tasks: 'open tasks',
  review: 'items to review',
  approvals: 'pending approvals',
};

/**
 * Custom Cogeto nav glyphs (P6.9). One cohesive family on a recurring node/orbit
 * motif — the "verification node" — so the set reads as bespoke, not a borrowed
 * icon pack. 20px viewBox, 1.6 stroke, currentColor.
 */
const G = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};
const ICONS: Record<NavSection, ReactNode> = {
  dashboard: (
    <svg viewBox="0 0 20 20" {...G}>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 10 13 6.5" />
      <circle cx="10" cy="10" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  ),
  memories: (
    <svg viewBox="0 0 20 20" {...G}>
      <circle cx="7" cy="7.5" r="2.4" />
      <circle cx="13.4" cy="9.2" r="2.4" />
      <circle cx="8.6" cy="13.4" r="2.4" />
      <path d="M8.9 8.3 11.5 9M8 9.7 8.3 11.3" />
    </svg>
  ),
  chat: (
    <svg viewBox="0 0 20 20" {...G}>
      <path d="M3.2 6.5h13.6M3.2 10h9M3.2 13.5h11" opacity="0.55" />
      <path d="M15 12l2.5 2.5" />
    </svg>
  ),
  research: (
    <svg viewBox="0 0 20 20" {...G}>
      <circle cx="9" cy="9" r="4.6" />
      <path d="M12.6 12.6 16.5 16.5" />
    </svg>
  ),
  timeline: (
    <svg viewBox="0 0 20 20" {...G}>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4l2.6 1.6" />
    </svg>
  ),
  tasks: (
    <svg viewBox="0 0 20 20" {...G}>
      <circle cx="10" cy="10" r="7" />
      <path d="M6.8 10.2 9 12.4 13.4 8" />
    </svg>
  ),
  review: (
    <svg viewBox="0 0 20 20" {...G}>
      <path d="M10 2.6 16.5 5.4v4.3c0 4-2.7 6.6-6.5 7.7C6.2 16.3 3.5 13.7 3.5 9.7V5.4z" />
      <path d="M7.2 9.8 9.3 11.9 12.9 7.9" />
    </svg>
  ),
  approvals: (
    <svg viewBox="0 0 20 20" {...G}>
      <rect x="3.4" y="4.4" width="13.2" height="11.2" rx="2.2" />
      <path d="M3.4 8.4h13.2" />
      <path d="M7 12.2 9 14l4-4.4" />
    </svg>
  ),
  forgotten: (
    <svg viewBox="0 0 20 20" {...G}>
      <path d="M5 3.2h10v13.6l-2-1.4-2 1.4-2-1.4-2 1.4z" />
      <path d="M8 7h4M8 10h4" opacity="0.7" />
    </svg>
  ),
  audit: (
    <svg viewBox="0 0 20 20" {...G}>
      <rect x="4" y="3.2" width="12" height="13.6" rx="2" />
      <path d="M7 7h6M7 10h6M7 13h4" opacity="0.75" />
    </svg>
  ),
  system: (
    <svg viewBox="0 0 20 20" {...G}>
      <rect x="3.2" y="4" width="13.6" height="12" rx="2.2" />
      <path d="M6 10.5l1.8-2.2 2 3 1.6-2 1 1.4h1.6" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 20 20" {...G}>
      <circle cx="10" cy="10" r="7" />
      <circle cx="10" cy="10" r="1" fill="currentColor" stroke="none" />
      <path d="M10 6.2v3.9l2.4 1.2" opacity="0.55" />
      <path d="M14.8 5.4 15.9 4M5.2 14.6 4.1 16" opacity="0.6" />
    </svg>
  ),
};

/** Initials for the sidebar avatar (up to two words). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const two = ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
  return two || '·';
}

/** Left navigation (P6.9): custom glyphs, and the identity + sign-out pinned to
 * the bottom instead of floating in the page header. */
export function Nav({
  active,
  reviewCount,
  approvalsCount,
  tasksCount,
  dashboardUnread = 0,
  showSystem = false,
  userName,
  orgName,
}: {
  active: NavSection;
  reviewCount?: number;
  approvalsCount?: number;
  tasksCount?: number;
  /** Unread attention items — a calm dot on the Dashboard item (Post-v1 P2). */
  dashboardUnread?: number;
  /** System is an operator surface (admin role, QS-10) — hidden for plain
   * users (o6-dry-run); the server-side AdminGuard stays the enforcement. */
  showSystem?: boolean;
  userName?: string;
  orgName?: string;
}) {
  const badges: Partial<Record<NavSection, number>> = {
    tasks: tasksCount ?? 0,
    review: reviewCount ?? 0,
    approvals: approvalsCount ?? 0,
  };
  const sections = ENABLED.filter((s) => s.key !== 'system' || showSystem);
  const demo = isDemoSession();
  return (
    <nav
      aria-label="Primary"
      className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-brand-navy-deep text-white"
    >
      <div className="border-b border-white/10 p-4">
        <img src="/brand/cogeto-final-logo-dark.svg" alt="Cogeto" className="h-8" />
      </div>
      <ul className="flex-1 space-y-0.5 overflow-y-auto p-3">
        {sections.map((section) => {
          const count = badges[section.key] ?? 0;
          const isActive = active === section.key;
          return (
            <li key={section.key}>
              <a
                href={section.href}
                aria-current={isActive ? 'page' : undefined}
                className={`group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-white/10 text-white'
                    : 'text-white/70 hover:bg-white/5 hover:text-white'
                }`}
              >
                {isActive && (
                  <span className="absolute -left-3 bottom-2 top-2 w-0.5 rounded-r bg-brand-teal" />
                )}
                <span
                  aria-hidden="true"
                  className={`grid h-5 w-5 shrink-0 place-items-center transition-colors ${
                    isActive ? 'text-brand-teal' : 'text-white/60 group-hover:text-white/90'
                  }`}
                >
                  {ICONS[section.key]}
                </span>
                <span className="flex-1 truncate">{section.label}</span>
                {count > 0 && (
                  <CountBadge count={count} label={BADGE_LABEL[section.key] ?? 'items'} />
                )}
                {section.key === 'dashboard' && dashboardUnread > 0 && !isActive && (
                  <span
                    className="h-2 w-2 rounded-full bg-brand-teal"
                    aria-label={`${dashboardUnread} new since you last looked`}
                  />
                )}
              </a>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-white/10 p-3">
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand-teal to-brand-teal-ink text-xs font-bold text-brand-navy">
            {initials(userName ?? 'Cogeto')}
          </span>
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-sm font-semibold text-white">
              {userName ?? 'Cogeto'}
            </span>
            {orgName && <span className="block truncate text-xs text-white/40">{orgName}</span>}
          </span>
        </div>
        {demo ? (
          <div className="mt-1 flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-brand-teal">
            <span aria-hidden="true">●</span> Live sandbox
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void logout()}
            className="mt-1 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-white/50 transition-colors hover:bg-white/5 hover:text-white"
          >
            <svg
              viewBox="0 0 20 20"
              className="h-[18px] w-[18px]"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 6.5V5a1.5 1.5 0 0 0-1.5-1.5h-5A1.5 1.5 0 0 0 4 5v10a1.5 1.5 0 0 0 1.5 1.5h5A1.5 1.5 0 0 0 12 15v-1.5" />
              <path d="M8.5 10h8m0 0-2.4-2.4M16.5 10l-2.4 2.4" />
            </svg>
            Sign out
          </button>
        )}
      </div>
    </nav>
  );
}
