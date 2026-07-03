import type { Session } from '../auth/oidc';
import { Shell } from '../components/Shell';
import { StatusPanel } from '../components/StatusPanel';

export function Dashboard({ session }: { session: Session }) {
  return (
    <Shell session={session} title="Dashboard" active="dashboard">
      <StatusPanel />
      <section className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">
        Memories is live (S2-A) — capture a note and watch the pipeline verify it. Chat, Review,
        Forgotten and Settings arrive with their vertical slices.
      </section>
    </Shell>
  );
}
