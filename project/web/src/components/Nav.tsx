export type NavSection =
  'dashboard' | 'memories' | 'chat' | 'tasks' | 'review' | 'forgotten' | 'system';

const ENABLED: { key: NavSection; label: string; href: string }[] = [
  { key: 'dashboard', label: 'Dashboard', href: '/' },
  { key: 'memories', label: 'Memories', href: '/memories' },
  { key: 'chat', label: 'Chat', href: '/chat' },
  { key: 'tasks', label: 'Tasks', href: '/tasks' },
  { key: 'review', label: 'Review', href: '/review' },
  { key: 'forgotten', label: 'Forgotten', href: '/forgotten' },
  { key: 'system', label: 'System', href: '/system' },
];
const UPCOMING = ['Settings'] as const;

/** Left navigation — future sections stubbed and disabled until their slices ship. */
export function Nav({ active, reviewCount }: { active: NavSection; reviewCount?: number }) {
  return (
    <nav className="flex w-56 flex-col border-r border-slate-200 bg-brand-navy-deep text-white">
      <div className="border-b border-white/10 p-4">
        <img src="/brand/cogeto-final-logo-dark.svg" alt="Cogeto" className="h-8" />
      </div>
      <ul className="flex-1 space-y-1 p-3">
        {ENABLED.map((section) => (
          <li key={section.key}>
            <a
              href={section.href}
              className={`flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium ${
                active === section.key ? 'bg-white/10' : 'text-white/70 hover:bg-white/5'
              }`}
            >
              {section.label}
              {section.key === 'review' && (reviewCount ?? 0) > 0 && (
                <span className="rounded-full bg-amber-400 px-1.5 text-xs font-bold text-slate-900">
                  {reviewCount}
                </span>
              )}
            </a>
          </li>
        ))}
        {UPCOMING.map((section) => (
          <li key={section}>
            <button
              type="button"
              disabled
              title="Coming in a later session"
              className="block w-full cursor-not-allowed rounded-md px-3 py-2 text-left text-sm text-white/40"
            >
              {section}
            </button>
          </li>
        ))}
      </ul>
      <div className="border-t border-white/10 p-3 text-xs text-white/40">
        Cogeto · verifiable memory
      </div>
    </nav>
  );
}
