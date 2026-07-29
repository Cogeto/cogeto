import type { Session } from '../auth/oidc';
import { AttentionSurface } from '../components/AttentionSurface';
import { Shell } from '../components/Shell';
import { StatsPanel } from '../components/StatsPanel';
import { StatusPanel } from '../components/StatusPanel';

/**
 * The home screen: attention first"what needs me right
 * now" — then the real statistics, then system status. The dreaming digest is
 * integrated into the attention surface (its "Last night" group), not a
 * separate panel; the digest endpoint/DTO contract is unchanged.
 */
export function Dashboard({ session }: { session: Session }) {
  return (
    <Shell session={session} title="Dashboard" active="dashboard">
      <AttentionSurface session={session} />
      <StatsPanel session={session} />
      <SkillsEntry />
      <StatusPanel />
    </Shell>
  );
}

/** The skills entry point: a quiet pointer, not a widget — the
 * run view on the Skills page is the surface. */
function SkillsEntry() {
  return (
    <a
      href="/skills"
      className="flex items-center gap-3 rounded-lg border border-slate-200 bg-surface p-4 shadow-sm transition-colors hover:border-brand-teal/40"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-teal/10 text-brand-teal-ink dark:text-brand-teal">
        <svg
          viewBox="0 0 20 20"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M10 3a7 7 0 1 1-7 7" />
          <circle cx="10" cy="3" r="1.3" />
          <circle cx="17" cy="10" r="1.3" />
          <circle cx="10" cy="17" r="1.3" />
        </svg>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-slate-800">
          Research a company or person before a meeting
        </span>
        <span className="block text-xs text-slate-500">
          A sourced brief: what you know, what changed, every step inspectable.
        </span>
      </span>
      <span aria-hidden="true" className="text-slate-400">
        →
      </span>
    </a>
  );
}
