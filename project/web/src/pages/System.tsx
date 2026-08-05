import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  fetchChainStatus,
  fetchDeadLetterJobs,
  fetchIntegrity,
  fetchMe,
  retryDeadLetterJob,
} from '../api';
import type { Session } from '../auth/oidc';
import { invalidateAfterJobRetry } from '../query-invalidation';
import { CapabilitiesPanel } from '../components/CapabilitiesPanel';
import { Shell } from '../components/Shell';
import { StatusPanel } from '../components/StatusPanel';
import { jobLabel, WorkerActivityPanel } from '../components/WorkerActivityPanel';
import { timeAgo } from '../components/status';
import {
  btnSecondary,
  Card,
  EmptyState,
  ErrorState,
  Pill,
  SectionTitle,
  SkeletonRows,
} from '../components/ui';

/** The sweep's face (spec §11.1 step 4): last run, chain status, open alert list. */
function IntegrityPanel({ session }: { session: Session }) {
  const { t } = useTranslation('system');
  const integrity = useQuery({
    queryKey: ['integrity'],
    queryFn: () => fetchIntegrity(session),
    refetchInterval: 10_000,
  });
  const chain = useQuery({
    queryKey: ['chain-status'],
    queryFn: () => fetchChainStatus(session),
    refetchInterval: 30_000,
  });
  const data = integrity.data;

  return (
    <Card>
      <div className="mb-3">
        <SectionTitle>{t('integrity.heading')}</SectionTitle>
      </div>
      {integrity.isPending && <SkeletonRows rows={2} label={t('integrity.loading')} />}
      {integrity.isError && <ErrorState>{t('integrity.error')}</ErrorState>}
      {data && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
            {data.openAlerts === 0 ? (
              <Pill tone="positive" icon="✓">
                {t('integrity.alerts', { count: 0 })}
              </Pill>
            ) : (
              <Pill tone="danger" icon="⚠">
                {t('integrity.alerts', { count: data.openAlerts })}
              </Pill>
            )}
            {chain.data &&
              (chain.data.ok ? (
                <Pill tone="positive" icon="✓">
                  {t('integrity.chainVerified', { count: chain.data.verified })}
                </Pill>
              ) : (
                <span title={chain.data.error}>
                  <Pill tone="danger" icon="✗">
                    {t('integrity.chainBroken')}
                  </Pill>
                </span>
              ))}
            <span className="text-xs text-slate-400">
              {data.lastSweepAt
                ? t('integrity.lastSweep', {
                    when: timeAgo(data.lastSweepAt),
                    receipts: data.lastReport?.receiptsChecked ?? 0,
                    identifiers: data.lastReport?.identifiersChecked ?? 0,
                  })
                : t('integrity.neverRun')}
            </span>
          </div>
          {data.alerts.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                    <th className="py-2 pr-3">{t('integrity.column.kind')}</th>
                    <th className="py-2 pr-3">{t('integrity.column.identifier')}</th>
                    <th className="py-2 pr-3">{t('integrity.column.receipt')}</th>
                    <th className="py-2 pr-3">{t('integrity.column.detected')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.alerts.map((alert) => (
                    <tr key={alert.id} className="border-b border-slate-100 align-top">
                      <td className="py-2 pr-3 font-medium text-red-700 dark:text-red-300">
                        {alert.kind}
                      </td>
                      <td className="max-w-64 break-all py-2 pr-3 font-mono text-xs text-slate-600">
                        {alert.detail}
                      </td>
                      <td className="py-2 pr-3 text-xs text-slate-500">
                        {alert.receiptId
                          ? `${alert.receiptId.slice(0, 8)}…`
                          : t('integrity.chainRow')}
                      </td>
                      <td className="py-2 pr-3 text-xs text-slate-400" title={alert.detectedAt}>
                        {timeAgo(alert.detectedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function DeadLetterTable({ session }: { session: Session }) {
  const { t } = useTranslation('system');
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data, isPending, isError } = useQuery({
    queryKey: ['dead-letter'],
    queryFn: () => fetchDeadLetterJobs(session),
    refetchInterval: 10_000,
  });
  const retry = useMutation({
    mutationFn: (id: string) => retryDeadLetterJob(session, id),
    onSuccess: async () => {
      setError(null);
      await invalidateAfterJobRetry(queryClient); //
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <Card>
      <div className="mb-3">
        <SectionTitle>{t('deadLetter.heading')}</SectionTitle>
      </div>
      {isPending && <SkeletonRows rows={2} label={t('deadLetter.loading')} />}
      {isError && <ErrorState>{t('deadLetter.error')}</ErrorState>}
      {error && (
        <div className="mb-2">
          <ErrorState>{error}</ErrorState>
        </div>
      )}
      {data && data.length === 0 && (
        <EmptyState icon="✓" tone="positive" title={t('deadLetter.empty.title')}>
          {t('deadLetter.empty.body')}
        </EmptyState>
      )}
      {data && data.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                <th className="py-2 pr-3">{t('deadLetter.column.job')}</th>
                <th className="py-2 pr-3">{t('deadLetter.column.key')}</th>
                <th className="py-2 pr-3">{t('deadLetter.column.error')}</th>
                <th className="py-2 pr-3">{t('deadLetter.column.attempts')}</th>
                <th className="py-2 pr-3">{t('deadLetter.column.failed')}</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {data.map((job) => (
                <tr key={job.id} className="border-b border-slate-100 align-top">
                  <td className="py-2 pr-3 font-medium text-slate-700">{jobLabel(job.jobType)}</td>
                  <td className="py-2 pr-3 text-xs text-slate-500">
                    {job.sourceType ?? t('deadLetter.noSource')}
                    {job.sourceId ? ` / ${job.sourceId.slice(0, 8)}…` : ''}
                  </td>
                  <td
                    className="max-w-64 py-2 pr-3 text-xs text-red-700 dark:text-red-300"
                    title={job.error}
                  >
                    {job.error.length > 120 ? `${job.error.slice(0, 120)}…` : job.error}
                  </td>
                  <td className="py-2 pr-3 text-slate-500">{job.attempts}</td>
                  <td className="py-2 pr-3 text-xs text-slate-400" title={job.failedAt}>
                    {timeAgo(job.failedAt)}
                  </td>
                  <td className="py-2">
                    <button
                      type="button"
                      disabled={retry.isPending}
                      onClick={() => retry.mutate(job.id)}
                      className={btnSecondary}
                    >
                      {t('deadLetter.retry')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/**
 * System (+): health, deletion integrity, dead-letter retry.
 * An operator surface: the admin-gated panels (worker activity, dead-letter —
 *) would 403 for a plain user, so the page explains itself instead of
 * erroring when the caller lacks the admin role (o6-dry-run). The nav hides
 * the entry too; this covers a direct URL.
 */
export function System({ session }: { session: Session }) {
  const { t } = useTranslation('system');
  const title = t('navigation:section.system');
  const me = useQuery({ queryKey: ['me'], queryFn: () => fetchMe(session), retry: 1 });
  if (me.data && !me.data.isAdmin) {
    return (
      <Shell session={session} title={title} active="system">
        <Card>
          <EmptyState tone="neutral" title={t('operatorOnly.title')}>
            {t('operatorOnly.body')}
          </EmptyState>
        </Card>
      </Shell>
    );
  }
  return (
    <Shell session={session} title={title} active="system">
      <StatusPanel session={session} />
      <CapabilitiesPanel session={session} />
      <WorkerActivityPanel session={session} />
      <IntegrityPanel session={session} />
      <DeadLetterTable session={session} />
    </Shell>
  );
}
