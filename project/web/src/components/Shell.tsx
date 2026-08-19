import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  fetchAttention,
  fetchContradictions,
  fetchMe,
  fetchModelConfig,
  fetchPendingApprovals,
  fetchSpaces,
} from '../api';
import type { Session } from '../auth/oidc';
import { currentSpaceId } from '../space';
import { Nav } from './Nav';
import type { NavSection } from './Nav';
import { SpaceSwitcher } from './SpaceSwitcher';
import { UserMenu } from './UserMenu';
import { btnPrimary } from './ui';

/** One uniform, fluid content width for every page: fills the screen up to
 * a roomy cap, then centers. Identical on every page — no per-page width. The
 * full-width app bar shares this column so its title lines up with the content. */
const COL = 'mx-auto w-full max-w-[80rem]';

/** The authenticated page frame: sidebar (identity + sign-out live there now),
 * a slim title bar, and the content column. */
export function Shell({
  session,
  title,
  active,
  children,
  fullHeight = false,
  leftRail,
}: {
  session: Session;
  title: string;
  active: NavSection;
  children: ReactNode;
  /** Pin the page to the viewport: children scroll internally (chat). */
  fullHeight?: boolean;
  /** A second full-height rail between the nav and the header/content column
   * (: the conversations sidebar). Living OUTSIDE the column keeps the
   * header breadcrumb and the content centered in the SAME remaining width,
   * so they stay aligned — a rail inside the column would shift the content
   * off the header's center line. */
  leftRail?: ReactNode;
}) {
  const { t } = useTranslation('common');
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: () => fetchMe(session),
    retry: 1,
  });
  // The badge counts open contradictions and nothing else (V2.0 item 3.3).
  // Uncertain facts used to be counted here too, when they were a queue
  // awaiting a verdict. They are resolved automatically now, so counting them
  // would be asking for attention that no action can discharge.
  const { data: contradictions } = useQuery({
    queryKey: ['contradictions'],
    queryFn: () => fetchContradictions(session),
    refetchInterval: 30_000,
  });
  // The approvals badge: pending consequential actions awaiting a decision.
  const { data: pendingApprovals } = useQuery({
    queryKey: ['pending-approvals'],
    queryFn: () => fetchPendingApprovals(session),
    refetchInterval: 30_000,
  });
  // The dashboard attention indicator (P2): unread since last viewed.
  // Shares the ['attention'] cache with the dashboard surface, so opening the
  // dashboard (which marks seen) clears this dot.
  const { data: attention } = useQuery({
    queryKey: ['attention'],
    queryFn: () => fetchAttention(session),
    refetchInterval: 30_000,
  });
  // The first-run state: no model provider configured. Shared cache key with
  // the pages that disable their capture surfaces off the same answer; the
  // interval is what makes configuring a provider lift the banner everywhere
  // without a reload.
  const { data: modelConfig } = useQuery({
    queryKey: ['model-config'],
    queryFn: () => fetchModelConfig(session),
    refetchInterval: 30_000,
  });
  // The spaces list (docs/features/spaces.md): feeds the switcher, and the
  // interval is what notices a space deleted in ANOTHER session, so this one
  // can say so instead of quietly gating every read to nothing.
  const { data: spaceList } = useQuery({
    queryKey: ['spaces'],
    queryFn: () => fetchSpaces(session),
    refetchInterval: 30_000,
  });
  const boundSpace = currentSpaceId();
  const currentSpaceGone =
    spaceList != null && boundSpace != null && !spaceList.spaces.some((s) => s.id === boundSpace);

  return (
    // Full-height pages (chat) take the shell OUT of document flow entirely
    // (fixed inset-0), so the document contributes zero scrollable height and
    // only the chat's inner pane can scroll. `h-screen overflow-hidden` alone
    // still let the whole page (sidebar and all) scroll into empty space in some
    // environments; a fixed shell cannot (fix). Normal pages stay in flow.
    <div
      className={`bg-slate-50 ${fullHeight ? 'fixed inset-0 flex overflow-hidden' : 'flex min-h-screen'}`}
    >
      <Nav
        active={active}
        reviewCount={contradictions?.length ?? 0}
        approvalsCount={pendingApprovals?.length ?? 0}
        dashboardUnread={attention?.unreadCount ?? 0}
        showSystem={me?.isAdmin === true}
        userName={me?.name}
        orgName={me?.orgName}
      />
      {leftRail}
      <div className={fullHeight ? 'flex h-screen min-h-0 flex-1 flex-col' : 'flex-1'}>
        <header className="shrink-0 border-b border-slate-200 bg-surface">
          {/* The header tops its content: full-height pages (chat) use the same
              narrow, centered column as their content, so the breadcrumb sits
              directly above the conversation instead of hanging off to the left
. Other pages fill the wide column, where it already aligns. */}
          <div
            className={`flex items-center gap-2 py-2.5 ${
              fullHeight ? 'mx-auto w-full max-w-3xl px-4' : `${COL} px-6`
            }`}
          >
            {/* The space switcher is the leftmost element on EVERY page
                (docs/features/spaces.md section 3): the current space is the
                single most important UI state in a sealed-partition product,
                so it is visible at all times, followed by the calm mono page
                breadcrumb. */}
            <SpaceSwitcher session={session} />
            <span className="text-slate-300 dark:text-slate-600" aria-hidden="true">
              ·
            </span>
            <h1 className="min-w-0 truncate font-mono text-[0.72rem] uppercase tracking-[0.14em]">
              <span className="font-semibold text-slate-700">{title}</span>
            </h1>
            {/* The instance area's door and the identity chip, at the right
                end: instance administration is deliberately OUTSIDE the
                space-scoped sidebar, which is what teaches that no space owns
                it. */}
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <a
                href="/instance"
                aria-label={t('navigation:instance.open')}
                title={t('navigation:instance.open')}
                className="grid h-8 w-8 place-items-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-teal dark:hover:bg-white/10"
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
                  <circle cx="10" cy="10" r="2.6" />
                  <path d="M10 2.8v2.4M10 14.8v2.4M2.8 10h2.4M14.8 10h2.4M4.9 4.9l1.7 1.7M13.4 13.4l1.7 1.7M15.1 4.9l-1.7 1.7M6.6 13.4l-1.7 1.7" />
                </svg>
              </a>
              <UserMenu userName={me?.name} orgName={me?.orgName} />
            </div>
          </div>
        </header>
        {modelConfig?.configured === false && (
          <div className="shrink-0 border-b border-amber-200 bg-amber-50">
            <div
              className={`py-2 text-sm text-amber-900 ${
                fullHeight ? 'mx-auto w-full max-w-3xl px-4' : `${COL} px-6`
              }`}
            >
              <span>{t('modelRequired.banner')}</span>{' '}
              {me?.isAdmin === true ? (
                <a href="/providers" className="font-medium underline hover:text-amber-950">
                  {t('modelRequired.configureCta')}
                </a>
              ) : (
                <span>{t('modelRequired.askAdmin')}</span>
              )}
            </div>
          </div>
        )}
        <main
          className={
            fullHeight ? `${COL} flex min-h-0 flex-1 flex-col gap-6 p-6` : `${COL} grid gap-6 p-6`
          }
        >
          {children}
        </main>
      </div>
      {/* A space deleted in ANOTHER session while this one had it selected:
          say so and move deliberately, never leave the user in a view that
          quietly gates every read to nothing (issue A5). The reload rebinds
          to the server-resolved space, which has already fallen back to the
          default. */}
      {currentSpaceGone && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/50 p-4">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="space-gone-title"
            aria-describedby="space-gone-body"
            className="w-full max-w-sm rounded-lg border border-slate-200 bg-surface p-5 shadow-xl"
          >
            <h2 id="space-gone-title" className="text-sm font-semibold text-slate-800">
              {t('spaces:deleted.title')}
            </h2>
            <p id="space-gone-body" className="mt-1.5 text-sm text-slate-600">
              {t('spaces:deleted.body')}
            </p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                className={btnPrimary}
                autoFocus
                onClick={() => window.location.assign('/')}
              >
                {t('spaces:deleted.cta')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
