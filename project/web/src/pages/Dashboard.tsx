import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { fetchDashboardStats, fetchSourceCatalog, fetchSpaces } from '../api';
import type { Session } from '../auth/oidc';
import { AttentionSurface } from '../components/AttentionSurface';
import { Shell } from '../components/Shell';
import { StatsPanel } from '../components/StatsPanel';
import { StatusPanel } from '../components/StatusPanel';
import { currentSpaceId } from '../space';
import { btnPrimary, btnSecondary } from '../components/ui';

/**
 * The home screen: attention first"what needs me right
 * now" — then the real statistics, then system status. The dreaming digest is
 * integrated into the attention surface (its "Last night" group), not a
 * separate panel; the digest endpoint/DTO contract is unchanged.
 */
export function Dashboard({ session }: { session: Session }) {
  const { t } = useTranslation('navigation');
  // A space with no memories yet opens on a deliberate first-run state
  // pointing at Chat and Sources, never a dashboard of empty panels
  // (docs/features/spaces.md section 3). Shares the StatsPanel's cache key,
  // so the check adds no request.
  const stats = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: () => fetchDashboardStats(session),
  });
  // "Empty" means NOTHING arrived: zero facts AND zero sources. A space with
  // documents waiting on a model provider is not empty, and telling its user
  // it is would be dishonest. The stats series only covers recent days, so a
  // zero-fact space asks the catalog for ONE row before claiming emptiness.
  const sourcesSeen = (stats.data?.sources.series ?? []).some((day) =>
    Object.values(day.counts).some((count) => count > 0),
  );
  const probe = useQuery({
    queryKey: ['source-catalog-probe'],
    queryFn: () => fetchSourceCatalog(session, { limit: 1 }),
    enabled: stats.data != null && stats.data.memoryTotal === 0 && !sourcesSeen,
  });
  const emptySpace =
    stats.data != null &&
    stats.data.memoryTotal === 0 &&
    !sourcesSeen &&
    probe.data != null &&
    probe.data.items.length === 0;
  return (
    <Shell session={session} title={t('section.dashboard')} active="dashboard">
      {emptySpace ? (
        <EmptySpaceWelcome session={session} />
      ) : (
        <>
          <AttentionSurface session={session} />
          <StatsPanel session={session} />
          <SkillsEntry />
          <StatusPanel session={session} />
        </>
      )}
    </Shell>
  );
}

/** The first-run state of a space that holds nothing yet: what a space is,
 * and the two doors in (the teaching tone of the product's other zero
 * states). Rendered from live counts, so the moment the first fact lands the
 * ordinary dashboard takes over. */
function EmptySpaceWelcome({ session }: { session: Session }) {
  const { t } = useTranslation('spaces');
  const { data: spaceList } = useQuery({
    queryKey: ['spaces'],
    queryFn: () => fetchSpaces(session),
  });
  const name = spaceList?.spaces.find((s) => s.id === currentSpaceId())?.name ?? '';
  return (
    <section className="rounded-lg border border-dashed border-brand-teal/40 bg-brand-teal-surface/40 p-10 text-center dark:border-brand-teal/30 dark:bg-brand-teal/10">
      <p className="text-sm font-semibold text-slate-800">{t('firstRun.title', { space: name })}</p>
      <p className="mx-auto mt-1.5 max-w-lg text-sm text-slate-500">{t('firstRun.body')}</p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        <a href="/chat" className={btnPrimary}>
          {t('firstRun.chatCta')}
        </a>
        <a href="/sources" className={btnSecondary}>
          {t('firstRun.sourcesCta')}
        </a>
      </div>
    </section>
  );
}

/** The skills entry point: a quiet pointer, not a widget — the
 * run view on the Skills page is the surface. */
function SkillsEntry() {
  const { t } = useTranslation('dashboard');
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
        <span className="block text-sm font-semibold text-slate-800">{t('skillsEntry.title')}</span>
        <span className="block text-xs text-slate-500">{t('skillsEntry.body')}</span>
      </span>
      <span aria-hidden="true" className="text-slate-400">
        →
      </span>
    </a>
  );
}
