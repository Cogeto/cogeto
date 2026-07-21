import type { Session } from '../auth/oidc';
import { AttentionSurface } from '../components/AttentionSurface';
import { Shell } from '../components/Shell';
import { StatsPanel } from '../components/StatsPanel';
import { StatusPanel } from '../components/StatusPanel';

/**
 * The home screen (Post-v1 Priority 2): attention first — "what needs me right
 * now" — then the real statistics, then system status. The dreaming digest is
 * integrated into the attention surface (its "Last night" group), not a
 * separate panel; the digest endpoint/DTO contract is unchanged.
 */
export function Dashboard({ session }: { session: Session }) {
  return (
    <Shell session={session} title="Dashboard" active="dashboard" wide>
      <AttentionSurface session={session} />
      <StatsPanel session={session} />
      <StatusPanel />
    </Shell>
  );
}
