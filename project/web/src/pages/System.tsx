import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchDeadLetterJobs, retryDeadLetterJob } from '../api';
import type { Session } from '../auth/oidc';
import { Shell } from '../components/Shell';
import { StatusPanel } from '../components/StatusPanel';
import { timeAgo } from '../components/status';

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
      await queryClient.invalidateQueries();
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
        Dead-letter queue
      </h2>
      {isPending && <p className="text-sm text-slate-400">Loading…</p>}
      {isError && <p className="text-sm text-red-600">Could not load the dead-letter queue.</p>}
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      {data && data.length === 0 && (
        <p className="text-sm text-slate-400">No parked jobs — every enqueued job completed.</p>
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
                    {job.sourceType ?? '—'}
                    {job.sourceId ? ` / ${job.sourceId.slice(0, 8)}…` : ''}
                  </td>
                  <td className="max-w-64 py-2 pr-3 text-xs text-red-600" title={job.error}>
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
                      className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-600 disabled:opacity-40"
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
    </section>
  );
}

/** System (S3-B): queue health + the dead-letter table with idempotent retry. */
export function System({ session }: { session: Session }) {
  return (
    <Shell session={session} title="System" active="system">
      <StatusPanel />
      <DeadLetterTable session={session} />
    </Shell>
  );
}
