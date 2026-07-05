import type { Session } from '../auth/oidc';
import { DreamDigest } from '../components/DreamDigest';
import { Shell } from '../components/Shell';
import { StatusPanel } from '../components/StatusPanel';

export function Dashboard({ session }: { session: Session }) {
  return (
    <Shell session={session} title="Dashboard" active="dashboard">
      <DreamDigest session={session} />
      <StatusPanel />
    </Shell>
  );
}
