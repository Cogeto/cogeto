import { useQuery } from '@tanstack/react-query';
import { fetchMe } from '../api';
import { logout } from '../auth/oidc';
import type { Session } from '../auth/oidc';
import { Nav } from '../components/Nav';
import { StatusPanel } from '../components/StatusPanel';

export function Dashboard({ session }: { session: Session }) {
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
      <Nav />
      <div className="flex-1">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold text-slate-800">Dashboard</h1>
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
        <main className="grid max-w-3xl gap-6 p-6">
          <StatusPanel />
          <section className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">
            Memories, Chat, Review, Forgotten and Settings arrive with their vertical slices (S1-B
            onward). This shell proves login, identity and infrastructure health.
          </section>
        </main>
      </div>
    </div>
  );
}
