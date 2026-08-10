import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type {
  CapabilitySummary,
  EmbeddingRebuildHealth,
  ScheduledJobSummary,
} from '@cogeto/shared';
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

/**
 * The managed embedding rebuild, when one is in flight (V2.4 item 7.1 second
 * half): an operator watching the instance sees what it is doing and how far
 * it has come, from the same state row every other surface reads. Running is
 * ordinary work in progress; failed carries the loud tone.
 */
function ReindexRow({ reindex }: { reindex: EmbeddingRebuildHealth }) {
  const { t } = useTranslation('capabilities');
  const failed = reindex.status === 'failed';
  return (
    <li className="rounded-md border border-slate-200 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-700">{t('reindex.name')}</span>
        <Pill tone={failed ? 'danger' : 'info'} icon={failed ? '✗' : '↻'}>
          {failed
            ? t('reindex.failed')
            : reindex.phase === 'finalizing'
              ? t('reindex.finalizing')
              : t('reindex.running')}
        </Pill>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        {t('reindex.progress', {
          model: reindex.targetModel,
          done: reindex.factsDone,
          total: reindex.factsTotal,
        })}
      </p>
      {reindex.error && (
        <p className="mt-1 text-xs font-medium text-red-700 dark:text-red-300">{reindex.error}</p>
      )}
    </li>
  );
}

/** Presentational section — the spec renders this directly with fixtures. */
export function CapabilitiesSection({
  capabilities,
  jobs,
  reindex,
}: {
  capabilities: CapabilitySummary[];
  jobs: ScheduledJobSummary[];
  reindex?: EmbeddingRebuildHealth | null;
}) {
  const { t } = useTranslation('capabilities');
  return (
    <>
      <ul className="space-y-2" aria-label={t('optionalCapabilities')}>
        {capabilities.map((summary) => (
          <CapabilityRow key={summary.id} summary={summary} />
        ))}
        {reindex && <ReindexRow reindex={reindex} />}
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
      {data && (
        <CapabilitiesSection
          capabilities={data.capabilities}
          jobs={data.jobs}
          reindex={data.reindex}
        />
      )}
    </Card>
  );
}
