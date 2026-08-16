import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isDemoSession, logout } from '../auth/oidc';
import { CountBadge } from './ui';

export type NavSection =
  | 'dashboard'
  | 'sources'
  | 'chat'
  | 'research'
  | 'skills'
  | 'timeline'
  | 'review'
  | 'reports'
  | 'approvals'
  | 'forgotten'
  | 'audit'
  | 'users'
  | 'providers'
  | 'models'
  | 'system'
  | 'settings';

/**
 * The rail. `key` is the section identifier (a route, never translated); the
 * label is looked up as `navigation:section.<key>` at render time so a language
 * change re-labels the rail without a reload.
 */
const ENABLED: { key: NavSection; href: string }[] = [
  { key: 'dashboard', href: '/' },
  // The Memories tab became Sources (V2.2 item 5.2): the read, audit and
  // resolve surface. The old flat list survives as the filtered fact search
  // on /memories, reachable from the Sources page rather than the rail.
  { key: 'sources', href: '/sources' },
  { key: 'chat', href: '/chat' },
  { key: 'research', href: '/research' },
  { key: 'skills', href: '/skills' },
  { key: 'timeline', href: '/timeline' },
  // Contradictions only (V2.0 item 3.3): the uncertain queue is gone, so the
  // surface is named for what is actually on it. The route stays `/review` so
  // the digest's conflict deep-links and attention hrefs do not dangle.
  { key: 'review', href: '/review' },
  // The findings report (V2.3 item 6.2): the signed artifact a QA lead
  // forwards. Beside Contradictions because a report is a findings run.
  { key: 'reports', href: '/reports' },
  { key: 'approvals', href: '/approvals' },
  { key: 'forgotten', href: '/forgotten' },
  { key: 'audit', href: '/audit' },
  // Erasing a departed person's material (issue #638). Operator surface, so
  // it sits with the others and is hidden for everyone else.
  { key: 'users', href: '/users' },
  // The two admin configuration surfaces (V2.4 item 7.1). Beside System, and
  // hidden for a non-admin exactly as System is; the server-side AdminGuard
  // stays the enforcement.
  { key: 'providers', href: '/providers' },
  { key: 'models', href: '/models' },
  { key: 'system', href: '/system' },
  { key: 'settings', href: '/settings' },
];

/** The noun the count badge announces, per section. */
const BADGE_NOUN_KEY: Partial<Record<NavSection, string>> = {
  review: 'badge.openContradictions',
  approvals: 'badge.pendingApprovals',
};

/**
 * Custom Cogeto nav glyphs. One cohesive family on a recurring node/orbit
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
  // The document tray: sources land here, deliberately.
  sources: (
    <svg viewBox="0 0 20 20" {...G}>
      <path d="M3.4 11.5V14a2.2 2.2 0 0 0 2.2 2.2h8.8a2.2 2.2 0 0 0 2.2-2.2v-2.5" />
      <path d="M3.4 11.5h4.1l1 1.6h3l1-1.6h4.1" opacity="0.7" />
      <path d="M10 3.4v6.2M7.6 7.4 10 9.8l2.4-2.4" />
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
  // The skill run: an orbit of steps advancing around the verification node.
  skills: (
    <svg viewBox="0 0 20 20" {...G}>
      <path d="M10 3a7 7 0 1 1-7 7" />
      <path d="M3 10a7 7 0 0 1 2-4.9" opacity="0.4" />
      <circle cx="10" cy="10" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="10" cy="3" r="1.3" />
      <circle cx="17" cy="10" r="1.3" />
      <circle cx="10" cy="17" r="1.3" />
    </svg>
  ),
  timeline: (
    <svg viewBox="0 0 20 20" {...G}>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4l2.6 1.6" />
    </svg>
  ),
  review: (
    <svg viewBox="0 0 20 20" {...G}>
      <path d="M10 2.6 16.5 5.4v4.3c0 4-2.7 6.6-6.5 7.7C6.2 16.3 3.5 13.7 3.5 9.7V5.4z" />
      <path d="M7.2 9.8 9.3 11.9 12.9 7.9" />
    </svg>
  ),
  reports: (
    <svg viewBox="0 0 20 20" {...G}>
      <path d="M5 2.8h7l3 3v11.4H5z" />
      <path d="M12 2.8v3h3" />
      <path d="M7.4 9.6h5.2M7.4 12.2h5.2" opacity="0.75" />
      <circle cx="14.2" cy="14.4" r="2.6" fill="var(--bg, #fff)" stroke="currentColor" />
      <path d="M13.2 14.5l0.8 0.8 1.4-1.6" />
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
  // Two figures on the recurring node motif: the person, and the colleague
  // behind them whose shared knowledge an erasure keeps.
  users: (
    <svg viewBox="0 0 20 20" {...G}>
      <circle cx="8" cy="7" r="2.6" />
      <path d="M3.4 16.2a4.6 4.6 0 0 1 9.2 0" />
      <path d="M13.4 5.2a2.6 2.6 0 0 1 0 5" opacity="0.5" />
      <path d="M14.6 12a4.6 4.6 0 0 1 2 3.6" opacity="0.5" />
    </svg>
  ),
  // The rack: endpoints you point at, stacked. Same family, same 1.6 stroke.
  providers: (
    <svg viewBox="0 0 20 20" {...G}>
      <rect x="3.4" y="3.6" width="13.2" height="4.4" rx="1.4" />
      <rect x="3.4" y="12" width="13.2" height="4.4" rx="1.4" />
      <path d="M6 5.8h0.01M6 14.2h0.01" strokeWidth="2" />
      <path d="M9.4 5.8h4.2M9.4 14.2h4.2" opacity="0.6" />
    </svg>
  ),
  // The assignment: one node, four tiers routed out of it.
  models: (
    <svg viewBox="0 0 20 20" {...G}>
      <circle cx="10" cy="10" r="2.2" />
      <path d="M10 7.8V3.6M10 12.2v4.2M7.8 10H3.6M12.2 10h4.2" opacity="0.75" />
      <circle cx="10" cy="3.6" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="16.4" cy="10" r="1.1" fill="currentColor" stroke="none" />
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

/** Left navigation: custom glyphs, and the identity + sign-out pinned to
 * the bottom instead of floating in the page header.
 *
 * The rail is pinned to the VIEWPORT, not the document. As a plain flex child
 * it stretched to the full page height, so on a long page (Memories, Audit)
 * the identity block and Sign out sat at the bottom of the document and were
 * only reachable by scrolling to the very end. `self-start` stops the stretch,
 * `h-screen` sizes the rail to the viewport, and `sticky top-0` keeps it there
 * while the page scrolls underneath; the item list's own `overflow-y-auto`
 * then does its real job when the sections outgrow a short window. Sticky's
 * containing block is the full-height shell, so the rail stays pinned at every
 * scroll position and its background never runs out. On full-height pages
 * (chat) the shell is `fixed inset-0`, where `h-screen` is already the
 * container height and sticky is inert: same render as before.
 */
export function Nav({
  active,
  reviewCount,
  approvalsCount,
  dashboardUnread = 0,
  showSystem = false,
  userName,
  orgName,
}: {
  active: NavSection;
  reviewCount?: number;
  approvalsCount?: number;
  /** Unread attention items — a calm dot on the Dashboard item (P2). */
  dashboardUnread?: number;
  /** System is an operator surface (admin role) — hidden for plain
   * users (o6-dry-run); the server-side AdminGuard stays the enforcement. */
  showSystem?: boolean;
  userName?: string;
  orgName?: string;
}) {
  const { t } = useTranslation('navigation');
  const badges: Partial<Record<NavSection, number>> = {
    review: reviewCount ?? 0,
    approvals: approvalsCount ?? 0,
  };
  // The operator surfaces share one gate: System, Providers and Model
  // assignment (V2.4 item 7.1), and now the activity trail (issue #633) — it
  // is the organisation's trail, not the reader's own, so it is an operator
  // surface and the server's AdminGuard is the enforcement.
  const adminOnly = new Set<NavSection>(['system', 'providers', 'models', 'audit', 'users']);
  const sections = ENABLED.filter((s) => !adminOnly.has(s.key) || showSystem);
  const demo = isDemoSession();
  return (
    <nav
      aria-label={t('landmark')}
      className="sticky top-0 flex h-screen w-60 shrink-0 flex-col self-start border-r border-slate-200 bg-brand-navy-deep text-white"
    >
      <div className="border-b border-white/10 p-4">
        <img
          src="/brand/cogeto-final-logo-dark.svg"
          alt={t('common:productName')}
          className="h-8"
        />
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
                    ? 'bg-brand-teal/15 text-white ring-1 ring-inset ring-brand-teal/25'
                    : 'text-white/75 hover:bg-white/[0.07] hover:text-white'
                }`}
              >
                {isActive && (
                  <span className="absolute -left-3 bottom-1.5 top-1.5 w-1 rounded-r bg-brand-teal shadow-[0_0_10px_0] shadow-brand-teal/60" />
                )}
                <span
                  aria-hidden="true"
                  className={`grid h-5 w-5 shrink-0 place-items-center transition-colors ${
                    isActive ? 'text-brand-teal' : 'text-white/70 group-hover:text-brand-teal'
                  }`}
                >
                  {ICONS[section.key]}
                </span>
                <span className="flex-1 truncate">{t(`section.${section.key}`)}</span>
                {count > 0 && (
                  <CountBadge
                    count={count}
                    label={t(BADGE_NOUN_KEY[section.key] ?? 'badge.items')}
                  />
                )}
                {section.key === 'dashboard' && dashboardUnread > 0 && !isActive && (
                  <span
                    className="h-2 w-2 rounded-full bg-brand-teal"
                    aria-label={t('badge.newSinceLastLook', { count: dashboardUnread })}
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
            {initials(userName ?? t('common:productName'))}
          </span>
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-sm font-semibold text-white">
              {userName ?? t('common:productName')}
            </span>
            {orgName && <span className="block truncate text-xs text-white/40">{orgName}</span>}
          </span>
        </div>
        {demo ? (
          <div className="mt-1 flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-brand-teal">
            <span aria-hidden="true">●</span> {t('liveSandbox')}
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
            {t('signOut')}
          </button>
        )}
        {/* The running version. It lived here until the sidebar was rebuilt,
            which dropped the line and left the build-time define with no
            consumer, so an operator verifying an upgrade had nothing to read.
            A hairline keeps it clearly apart from the session controls. */}
        <div
          className="mt-2 border-t border-white/5 px-3 pt-2 text-[0.65rem] text-white/30"
          title={t('versionTitle')}
        >
          v{__APP_VERSION__}
        </div>
      </div>
    </nav>
  );
}
