import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  fetchContradictions,
  fetchMe,
  fetchMemories,
  fetchPendingApprovals,
  fetchTaskCount,
} from '../api';
import { logout } from '../auth/oidc';
import type { Session } from '../auth/oidc';
import { Nav } from './Nav';
import type { NavSection } from './Nav';

/** The authenticated page frame: nav, identity header, content column. */
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
    queryFn: () => fetchMemories(session, { status: 'uncertain', limit: 1 }),
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

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav
        active={active}
        reviewCount={(uncertain?.total ?? 0) + (contradictions?.length ?? 0)}
        approvalsCount={pendingApprovals?.length ?? 0}
        tasksCount={taskCount?.open ?? 0}
      />
      <div className={fullHeight ? 'flex h-screen min-h-0 flex-1 flex-col' : 'flex-1'}>
        <header className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold text-slate-800">{title}</h1>
            {isPending && <p className="text-sm text-slate-400">Loading identity…</p>}
            {isError && <p className="text-sm text-red-600">Could not load /api/me.</p>}
            {me && (
              <p className="text-sm text-slate-500">
                {me.name} · <span className="font-medium">{me.orgName}</span>
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => void logout()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
          >
            Sign out
          </button>
        </header>
        <main
          className={
            fullHeight
              ? 'flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-6 p-6'
              : 'grid max-w-3xl gap-6 p-6'
          }
        >
          {children}
        </main>
      </div>
    </div>
  );
}
