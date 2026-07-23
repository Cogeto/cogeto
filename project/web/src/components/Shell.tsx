import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  fetchAttention,
  fetchContradictions,
  fetchMe,
  fetchMemories,
  fetchPendingApprovals,
  fetchTaskCount,
} from '../api';
import { isDemoSession, logout } from '../auth/oidc';
import type { Session } from '../auth/oidc';
import { Nav } from './Nav';
import type { NavSection } from './Nav';

/** Content-width tiers (P6.9). The column is centered (mx-auto) at a width that
 * suits the page: reading text stays comfortable, data-dense pages get the room,
 * the dashboard runs near-full. This replaces the single left-hugging max-w-3xl
 * that left a dead gutter on wide screens. */
export type ShellWidth = 'reading' | 'standard' | 'wide' | 'full';
const COLUMN: Record<ShellWidth, string> = {
  reading: 'max-w-3xl', // 48rem — long-form reading (chat, narrow forms)
  standard: 'max-w-5xl', // 64rem — default
  wide: 'max-w-7xl', // 80rem — tables, lists, grids
  full: 'max-w-[90rem]', // 1440px cap — the instrument dashboard
};

/** The authenticated page frame: nav, identity header, content column. */
export function Shell({
  session,
  title,
  active,
  children,
  fullHeight = false,
  width = 'standard',
}: {
  session: Session;
  title: string;
  active: NavSection;
  children: ReactNode;
  /** Pin the page to the viewport: children scroll internally (chat). */
  fullHeight?: boolean;
  /** Centered content-column width tier (P6.9). Defaults to `standard`. */
  width?: ShellWidth;
}) {
  const {
    data: me,
    isPending,
    isError,
  } = useQuery({
    queryKey: ['me'],
    queryFn: () => fetchMe(session),
    retry: 1,
  });
  // The review badge counts BOTH queues: uncertain memories awaiting a
  // verdict plus open contradictions awaiting a resolution (F2-A).
  const { data: uncertain } = useQuery({
    queryKey: ['uncertain-count'],
    // Own uncertain only (O2-B) — the badge mirrors the Review queue's scope.
    queryFn: () => fetchMemories(session, { status: 'uncertain', mine: true, limit: 1 }),
    refetchInterval: 30_000,
  });
  const { data: contradictions } = useQuery({
    queryKey: ['contradictions'],
    queryFn: () => fetchContradictions(session),
    refetchInterval: 30_000,
  });
  // The approvals badge: pending consequential actions awaiting a decision (§A.8).
  const { data: pendingApprovals } = useQuery({
    queryKey: ['pending-approvals'],
    queryFn: () => fetchPendingApprovals(session),
    refetchInterval: 30_000,
  });
  // The tasks badge: open + blocked, owner-scoped (F3 handoff §4).
  const { data: taskCount } = useQuery({
    queryKey: ['task-count'],
    queryFn: () => fetchTaskCount(session),
    refetchInterval: 30_000,
  });
  // The dashboard attention indicator (Post-v1 P2): unread since last viewed.
  // Shares the ['attention'] cache with the dashboard surface, so opening the
  // dashboard (which marks seen) clears this dot.
  const { data: attention } = useQuery({
    queryKey: ['attention'],
    queryFn: () => fetchAttention(session),
    refetchInterval: 30_000,
  });

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav
        active={active}
        reviewCount={(uncertain?.total ?? 0) + (contradictions?.length ?? 0)}
        approvalsCount={pendingApprovals?.length ?? 0}
        tasksCount={taskCount?.open ?? 0}
        dashboardUnread={attention?.unreadCount ?? 0}
        showSystem={me?.isAdmin === true}
      />
      <div className={fullHeight ? 'flex h-screen min-h-0 flex-1 flex-col' : 'flex-1'}>
        {/* Full-width app bar; its inner row shares the content column so the
            title lines up with the page content (P6.9). */}
        <header className="shrink-0 border-b border-slate-200 bg-surface">
          <div
            className={`mx-auto flex w-full items-center justify-between px-6 py-4 ${COLUMN[width]}`}
          >
            <div>
              <h1 className="text-lg font-semibold text-slate-800">{title}</h1>
              {isPending && <p className="text-sm text-slate-400">Loading identity…</p>}
              {isError && (
                <p className="text-sm text-red-600 dark:text-red-300">Could not load /api/me.</p>
              )}
              {me && (
                <p className="text-sm text-slate-500">
                  {me.name} · <span className="font-medium">{me.orgName}</span>
                </p>
              )}
            </div>
            {isDemoSession() ? (
              // Sandbox: no sign-out (no account to leave); a subtle sandbox tag.
              <span className="inline-flex items-center gap-1 rounded-full bg-brand-teal-surface dark:bg-brand-teal/15 px-3 py-1 text-xs font-semibold text-brand-teal-ink dark:text-brand-teal">
                <span aria-hidden="true">●</span> Live sandbox
              </span>
            ) : (
              <button
                type="button"
                onClick={() => void logout()}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
              >
                Sign out
              </button>
            )}
          </div>
        </header>
        <main
          className={
            fullHeight
              ? `mx-auto flex w-full min-h-0 flex-1 flex-col gap-6 p-6 ${COLUMN[width]}`
              : `mx-auto grid w-full gap-6 p-6 ${COLUMN[width]}`
          }
        >
          {children}
        </main>
      </div>
    </div>
  );
}
