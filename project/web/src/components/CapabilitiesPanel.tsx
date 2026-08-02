import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { CapabilitySummary, ScheduledJobSummary } from '@cogeto/shared';
import { fetchHealth } from '../api';
import type { Session } from '../auth/oidc';
import { capabilityView, jobView } from './capabilities-model';
import { timeAgo } from './status';
import { Card, ErrorState, Pill, SectionTitle, SkeletonRows } from './ui';

/**
 * The Capabilities panel: every optional capability and
 * nightly job of this instance with its TRUE state, from the same registry
 * /api/health serves. Loud states carry a plain consequence line; disabled
 * capabilities say how an operator enables them (the product never toggles
 * them: enabling means starting containers, and the web app holds no docker
 * privilege). Dark-first; states are label + icon, never colour only.
 */

function CapabilityRow({ summary }: { summary: CapabilitySummary }) {
  const { t } = useTranslation('capabilities');
  const view = capabilityView(summary);
  return (
    <li className="rounded-md border border-slate-200 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-700">{view.name}</span>
        <span className="flex items-center gap-2">
          <span className="text-xs text-slate-400" title={view.checkedAt}>
            {t('checkedAt', { when: timeAgo(view.checkedAt) })}
          </span>
          <Pill tone={view.tone} icon={view.icon}>
            {view.stateLabel}
          </Pill>
        </span>
      </div>
      <p className="mt-1 text-xs text-slate-500">{view.description}</p>
      {view.consequence && (
        <p className="mt-1 text-xs font-medium text-red-700 dark:text-red-300">
          {view.consequence}
        </p>
      )}
      {view.enableHint && (
        <p className="mt-1 text-xs text-slate-400">
          {t('enablePrefix')} <code className="font-mono">{view.enableHint}</code>
        </p>
      )}
    </li>
  );
}

function JobRow({ summary }: { summary: ScheduledJobSummary }) {
  const { t } = useTranslation('capabilities');
  const view = jobView(summary);
  return (
    <li className="rounded-md border border-slate-200 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-700">{view.name}</span>
        <span className="flex items-center gap-2">
          <span className="text-xs text-slate-400" title={view.lastRunAt ?? undefined}>
            {view.lastRunAt ? t('lastRan', { when: timeAgo(view.lastRunAt) }) : t('neverRan')}
          </span>
          <Pill tone={view.tone} icon={view.icon}>
            {view.stateLabel}
          </Pill>
        </span>
      </div>
      <p className="mt-1 text-xs text-slate-500">{view.description}</p>
      {view.lastResult && (
        <p className="mt-1 text-xs text-slate-400">
          {t('lastResult', { result: view.lastResult })}
        </p>
      )}
      {view.consequence && (
        <p className="mt-1 text-xs font-medium text-red-700 dark:text-red-300">
          {view.consequence}
        </p>
      )}
    </li>
  );
}

/** Presentational section — the spec renders this directly with fixtures. */
export function CapabilitiesSection({
  capabilities,
  jobs,
}: {
  capabilities: CapabilitySummary[];
  jobs: ScheduledJobSummary[];
}) {
  const { t } = useTranslation('capabilities');
  return (
    <>
      <ul className="space-y-2" aria-label={t('optionalCapabilities')}>
        {capabilities.map((summary) => (
          <CapabilityRow key={summary.id} summary={summary} />
        ))}
      </ul>
      <div className="mb-2 mt-4">
        <SectionTitle>{t('scheduledJobs')}</SectionTitle>
      </div>
      <ul className="space-y-2" aria-label={t('scheduledJobs')}>
        {jobs.map((summary) => (
          <JobRow key={summary.id} summary={summary} />
        ))}
      </ul>
    </>
  );
}

export function CapabilitiesPanel({ session }: { session: Session }) {
  const { t } = useTranslation('capabilities');
  const { data, isPending, isError } = useQuery({
    queryKey: ['health'],
    queryFn: () => fetchHealth(session),
    refetchInterval: 10_000,
  });

  return (
    <Card>
      <div className="mb-3">
        <SectionTitle>{t('heading')}</SectionTitle>
      </div>
      {isPending && <SkeletonRows rows={5} label={t('loading')} />}
      {isError && <ErrorState>{t('system:health.unreachable')}</ErrorState>}
      {data && <CapabilitiesSection capabilities={data.capabilities} jobs={data.jobs} />}
    </Card>
  );
}
