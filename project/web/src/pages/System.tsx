import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchChainStatus,
  fetchDeadLetterJobs,
  fetchIntegrity,
  fetchMe,
  retryDeadLetterJob,
} from '../api';
import type { Session } from '../auth/oidc';
import { invalidateAfterJobRetry } from '../query-invalidation';
import { Shell } from '../components/Shell';
import { StatusPanel } from '../components/StatusPanel';
import { WorkerActivityPanel } from '../components/WorkerActivityPanel';
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

/** The sweep's face (§A.7 step 4): last run, chain status, open alert list. */
function IntegrityPanel({ session }: { session: Session }) {
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
        <SectionTitle>Deletion integrity</SectionTitle>
      </div>
      {integrity.isPending && <SkeletonRows rows={2} label="Loading sweep status…" />}
      {integrity.isError && <ErrorState>We couldn’t load the sweep status.</ErrorState>}
      {data && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
            {data.openAlerts === 0 ? (
              <Pill tone="positive" icon="✓">
                0 integrity alerts
              </Pill>
            ) : (
              <Pill tone="danger" icon="⚠">
                {data.openAlerts} integrity alert{data.openAlerts === 1 ? '' : 's'}
              </Pill>
            )}
            {chain.data &&
              (chain.data.ok ? (
                <Pill tone="positive" icon="✓">
                  chain verified ({chain.data.verified})
                </Pill>
              ) : (
                <span title={chain.data.error}>
                  <Pill tone="danger" icon="✗">
                    chain BROKEN
                  </Pill>
                </span>
              ))}
            <span className="text-xs text-slate-400">
              {data.lastSweepAt
                ? `last sweep ${timeAgo(data.lastSweepAt)}, ${data.lastReport?.receiptsChecked ?? 0} receipt(s), ${data.lastReport?.identifiersChecked ?? 0} identifier(s) checked`
                : 'sweep has not run yet (nightly at 03:00, or run it on demand)'}
            </span>
          </div>
          {data.alerts.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                    <th className="py-2 pr-3">Kind</th>
                    <th className="py-2 pr-3">Identifier</th>
                    <th className="py-2 pr-3">Receipt</th>
                    <th className="py-2 pr-3">Detected</th>
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
                        {alert.receiptId ? `${alert.receiptId.slice(0, 8)}…` : '(chain)'}
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
      await invalidateAfterJobRetry(queryClient); // QS-36
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <Card>
      <div className="mb-3">
        <SectionTitle>Dead-letter queue</SectionTitle>
      </div>
      {isPending && <SkeletonRows rows={2} label="Loading dead-letter queue…" />}
      {isError && <ErrorState>We couldn’t load the dead-letter queue.</ErrorState>}
      {error && (
        <div className="mb-2">
          <ErrorState>{error}</ErrorState>
        </div>
      )}
      {data && data.length === 0 && (
        <EmptyState icon="✓" tone="positive" title="No parked jobs">
          Every enqueued job completed. Jobs that permanently fail land here to retry.
        </EmptyState>
      )}
      {data && data.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                <th className="py-2 pr-3">Job</th>
                <th className="py-2 pr-3">Key</th>
                <th className="py-2 pr-3">Error</th>
                <th className="py-2 pr-3">Attempts</th>
                <th className="py-2 pr-3">Failed</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {data.map((job) => (
                <tr key={job.id} className="border-b border-slate-100 align-top">
                  <td className="py-2 pr-3 font-medium text-slate-700">{job.jobType}</td>
                  <td className="py-2 pr-3 text-xs text-slate-500">
                    {job.sourceType ?? 'n/a'}
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
                      Retry
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
 * System (S3-B + F1-B): health, deletion integrity, dead-letter retry.
 * An operator surface: the admin-gated panels (worker activity, dead-letter —
 * QS-10) would 403 for a plain user, so the page explains itself instead of
 * erroring when the caller lacks the admin role (o6-dry-run). The nav hides
 * the entry too; this covers a direct URL.
 */
export function System({ session }: { session: Session }) {
  const me = useQuery({ queryKey: ['me'], queryFn: () => fetchMe(session), retry: 1 });
  if (me.data && !me.data.isAdmin) {
    return (
      <Shell session={session} title="System" active="system">
        <Card>
          <EmptyState tone="neutral" title="The System view is the operator's surface">
            Job activity and the dead-letter queue require the administrator role. Your account
            doesn't have it, and everyday use never needs it. If you co-operate this instance, ask
            the operator to grant you the role in Zitadel (Projects → cogeto → Authorizations).
          </EmptyState>
        </Card>
      </Shell>
    );
  }
  return (
    <Shell session={session} title="System" active="system">
      <StatusPanel />
      <WorkerActivityPanel session={session} />
      <IntegrityPanel session={session} />
      <DeadLetterTable session={session} />
    </Shell>
  );
}
