import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchMe } from '../api';
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
}: {
  session: Session;
  title: string;
  active: NavSection;
  children: ReactNode;
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

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Nav active={active} />
      <div className="flex-1">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
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
        <main className="grid max-w-3xl gap-6 p-6">{children}</main>
      </div>
    </div>
  );
}
