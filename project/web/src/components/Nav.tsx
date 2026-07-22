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

import { CountBadge } from './ui';

const BADGE_LABEL: Partial<Record<NavSection, string>> = {
  tasks: 'open tasks',
  review: 'items to review',
  approvals: 'pending approvals',
};

/** Left navigation — every section now ships (O1-C removed the disabled stubs). */
export function Nav({
  active,
  reviewCount,
  approvalsCount,
  tasksCount,
  dashboardUnread = 0,
  showSystem = false,
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
}) {
  const badges: Partial<Record<NavSection, number>> = {
    tasks: tasksCount ?? 0,
    review: reviewCount ?? 0,
    approvals: approvalsCount ?? 0,
  };
  const sections = ENABLED.filter((s) => s.key !== 'system' || showSystem);
  return (
    <nav
      aria-label="Primary"
      className="flex w-56 flex-col border-r border-slate-200 bg-brand-navy-deep text-white"
    >
      <div className="border-b border-white/10 p-4">
        <img src="/brand/cogeto-final-logo-dark.svg" alt="Cogeto" className="h-8" />
      </div>
      <ul className="flex-1 space-y-1 p-3">
        {sections.map((section) => {
          const count = badges[section.key] ?? 0;
          return (
            <li key={section.key}>
              <a
                href={section.href}
                aria-current={active === section.key ? 'page' : undefined}
                className={`flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  active === section.key
                    ? 'bg-white/10 text-white'
                    : 'text-white/70 hover:bg-white/5'
                }`}
              >
                {section.label}
                {count > 0 && (
                  <CountBadge count={count} label={BADGE_LABEL[section.key] ?? 'items'} />
                )}
                {section.key === 'dashboard' && dashboardUnread > 0 && active !== 'dashboard' && (
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
      <div className="border-t border-white/10 p-3 text-xs text-white/40">
        <div>Cogeto · verifiable memory</div>
        <div className="mt-0.5 text-white/30" title="Cogeto version">
          v{__APP_VERSION__}
        </div>
      </div>
    </nav>
  );
}
