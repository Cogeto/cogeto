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
import type { Session } from '../auth/oidc';
import { Nav } from './Nav';
import type { NavSection } from './Nav';

/** One uniform, fluid content width for every page (P6.9): fills the screen up to
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
}: {
  session: Session;
  title: string;
  active: NavSection;
  children: ReactNode;
  /** Pin the page to the viewport: children scroll internally (chat). */
  fullHeight?: boolean;
}) {
  const { data: me } = useQuery({
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
        userName={me?.name}
        orgName={me?.orgName}
      />
      <div className={fullHeight ? 'flex h-screen min-h-0 flex-1 flex-col' : 'flex-1'}>
        <header className="shrink-0 border-b border-slate-200 bg-surface">
          <div className={`${COL} flex items-center justify-between px-6 py-4`}>
            <h1 className="text-lg font-semibold text-slate-800">{title}</h1>
          </div>
        </header>
        <main
          className={
            fullHeight ? `${COL} flex min-h-0 flex-1 flex-col gap-6 p-6` : `${COL} grid gap-6 p-6`
          }
        >
          {children}
        </main>
      </div>
    </div>
  );
}
