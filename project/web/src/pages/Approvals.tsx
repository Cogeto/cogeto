import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApprovalDto, ApprovalStatus } from '@cogeto/shared';
import { confirmApproval, fetchApprovalHistory, fetchPendingApprovals } from '../api';
import type { Session } from '../auth/oidc';
import { Shell } from '../components/Shell';
import { timeAgo } from '../components/status';

const STATUS_CHIP: Record<ApprovalStatus, string> = {
  draft: 'bg-slate-100 text-slate-600',
  pending_approval: 'bg-amber-100 text-amber-700',
  approved: 'bg-sky-100 text-sky-700',
  executed: 'bg-brand-teal/15 text-brand-teal',
  rejected: 'bg-red-100 text-red-600',
  expired: 'bg-slate-200 text-slate-500',
};
const STATUS_LABEL: Record<ApprovalStatus, string> = {
  draft: 'draft',
  pending_approval: 'pending',
  approved: 'approved',
  executed: 'executed',
  rejected: 'rejected',
  expired: 'expired',
};

function StatusChip({ status }: { status: ApprovalStatus }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CHIP[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function PendingCard({ session, approval }: { session: Session; approval: ApprovalDto }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') => confirmApproval(session, approval.id, decision),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries();
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <li className="rounded-md border border-slate-200 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-800">{approval.summary}</p>
          <p className="mt-0.5 text-xs text-slate-400">
            {approval.actionType} · requested by {approval.requestedBy ?? 'unknown'}
            {approval.createdAt ? ` · ${timeAgo(approval.createdAt)}` : ''}
          </p>
        </div>
        <StatusChip status={approval.status} />
      </div>

      {approval.preview.length > 0 && (
        <ul className="mt-2 space-y-0.5 rounded-md bg-slate-50 p-2 text-xs text-slate-600">
          {approval.preview.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}

      {approval.expiresAt && (
        <p className="mt-2 text-xs text-slate-400">
          Expires {new Date(approval.expiresAt).toLocaleString()}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={decide.isPending}
          onClick={() => decide.mutate('approve')}
          className="rounded-md bg-brand-teal px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={decide.isPending}
          onClick={() => {
            if (window.confirm('Reject this action? It will not run.')) decide.mutate('reject');
          }}
          className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-600 disabled:opacity-40"
        >
          Reject
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-400">
        Approving runs the action server-side in the worker — this is the only path; there is no
        client-side shortcut.
      </p>
    </li>
  );
}

function HistoryRow({ approval }: { approval: ApprovalDto }) {
  const when = approval.executedAt ?? approval.decidedAt;
  return (
    <li className="flex items-start justify-between gap-3 border-b border-slate-100 py-2 text-sm">
      <div>
        <p className="text-slate-700">{approval.summary}</p>
        <p className="text-xs text-slate-400">
          {approval.actionType}
          {approval.decidedBy ? ` · decided by ${approval.decidedBy}` : ''}
          {when ? ` · ${timeAgo(when)}` : ''}
        </p>
        {approval.result && <p className="mt-0.5 text-xs text-brand-teal">{approval.result}</p>}
      </div>
      <StatusChip status={approval.status} />
    </li>
  );
}

/** Pending Approvals (§A.8, O1-B): the sole approval surface + read-only history. */
export function Approvals({ session }: { session: Session }) {
  const [tab, setTab] = useState<'pending' | 'history'>('pending');
  const pending = useQuery({
    queryKey: ['pending-approvals'],
    queryFn: () => fetchPendingApprovals(session),
    refetchInterval: 15_000,
  });
  const history = useQuery({
    queryKey: ['approval-history'],
    queryFn: () => fetchApprovalHistory(session),
    enabled: tab === 'history',
  });

  return (
    <Shell session={session} title="Approvals" active="approvals">
      <div className="mb-4 flex gap-2">
        {(['pending', 'history'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              tab === t ? 'bg-brand-teal text-white' : 'border border-slate-300 text-slate-600'
            }`}
          >
            {t === 'pending' ? 'Pending' : 'History'}
            {t === 'pending' && (pending.data?.length ?? 0) > 0 && (
              <span className="ml-1.5 rounded-full bg-amber-400 px-1.5 text-xs font-bold text-slate-900">
                {pending.data?.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === 'pending' && (
        <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          {pending.isPending && <p className="text-sm text-slate-400">Loading…</p>}
          {pending.isError && (
            <p className="text-sm text-red-600">Could not load pending approvals.</p>
          )}
          {pending.data && pending.data.length === 0 && (
            <p className="text-sm text-slate-400">
              No actions awaiting approval. Consequential actions (e.g. a bulk memory change from
              Memories) appear here for you to approve or reject.
            </p>
          )}
          {pending.data && pending.data.length > 0 && (
            <ul className="space-y-3">
              {pending.data.map((a) => (
                <PendingCard key={a.id} session={session} approval={a} />
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === 'history' && (
        <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          {history.isPending && <p className="text-sm text-slate-400">Loading…</p>}
          {history.data && history.data.length === 0 && (
            <p className="text-sm text-slate-400">No decided approvals yet.</p>
          )}
          {history.data && history.data.length > 0 && (
            <ul>
              {history.data.map((a) => (
                <HistoryRow key={a.id} approval={a} />
              ))}
            </ul>
          )}
        </section>
      )}
    </Shell>
  );
}
