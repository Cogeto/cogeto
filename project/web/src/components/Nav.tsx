export type NavSection =
  | 'dashboard'
  | 'memories'
  | 'chat'
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
}: {
  active: NavSection;
  reviewCount?: number;
  approvalsCount?: number;
  tasksCount?: number;
}) {
  const badges: Partial<Record<NavSection, number>> = {
    tasks: tasksCount ?? 0,
    review: reviewCount ?? 0,
    approvals: approvalsCount ?? 0,
  };
  return (
    <nav
      aria-label="Primary"
      className="flex w-56 flex-col border-r border-slate-200 bg-brand-navy-deep text-white"
    >
      <div className="border-b border-white/10 p-4">
        <img src="/brand/cogeto-final-logo-dark.svg" alt="Cogeto" className="h-8" />
      </div>
      <ul className="flex-1 space-y-1 p-3">
        {ENABLED.map((section) => {
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
              </a>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-white/10 p-3 text-xs text-white/40">
        Cogeto · verifiable memory
      </div>
    </nav>
  );
}
