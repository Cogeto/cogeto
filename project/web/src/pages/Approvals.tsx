import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApprovalDto, ApprovalStatus } from '@cogeto/shared';
import { confirmApproval, fetchApprovalHistory, fetchPendingApprovals } from '../api';
import type { Session } from '../auth/oidc';
import { invalidateAfterApproval } from '../query-invalidation';
import { Shell } from '../components/Shell';
import { timeAgo } from '../components/status';
import type { Tone } from '../components/status';
import {
  btnDanger,
  btnPrimary,
  Card,
  CountBadge,
  EmptyState,
  ErrorState,
  Pill,
  SkeletonRows,
  Tabs,
} from '../components/ui';

const STATUS_TONE: Record<ApprovalStatus, Tone> = {
  draft: 'neutral',
  pending_approval: 'warning',
  approved: 'info',
  executed: 'positive',
  rejected: 'danger',
  expired: 'neutral',
};
const STATUS_LABEL: Record<ApprovalStatus, string> = {
  draft: 'draft',
  pending_approval: 'pending',
  approved: 'approved',
  executed: 'executed',
  rejected: 'rejected',
  expired: 'expired',
};

function ApprovalPill({ status }: { status: ApprovalStatus }) {
  return <Pill tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Pill>;
}

function PendingCard({ session, approval }: { session: Session; approval: ApprovalDto }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') => confirmApproval(session, approval.id, decision),
    onSuccess: async () => {
      setError(null);
      await invalidateAfterApproval(queryClient); // QS-36
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <li className="rounded-lg border border-slate-200 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-800">{approval.summary}</p>
          <p className="mt-0.5 text-xs text-slate-400">
            {approval.actionType} · requested by {approval.requestedBy ?? 'unknown'}
            {approval.createdAt ? ` · ${timeAgo(approval.createdAt)}` : ''}
          </p>
        </div>
        <ApprovalPill status={approval.status} />
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
          className={btnPrimary}
        >
          Approve
        </button>
        <button
          type="button"
          disabled={decide.isPending}
          onClick={() => {
            if (window.confirm('Reject this action? It will not run.')) decide.mutate('reject');
          }}
          className={btnDanger}
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
        {approval.result && <p className="mt-0.5 text-xs text-brand-teal-ink">{approval.result}</p>}
      </div>
      <ApprovalPill status={approval.status} />
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
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          {
            key: 'pending',
            label: (
              <span className="flex items-center gap-1.5">
                Pending
                {(pending.data?.length ?? 0) > 0 && (
                  <CountBadge count={pending.data!.length} label="awaiting approval" />
                )}
              </span>
            ),
          },
          { key: 'history', label: 'History' },
        ]}
      />

      {tab === 'pending' && (
        <Card>
          {pending.isPending && <SkeletonRows rows={2} label="Loading approvals…" />}
          {pending.isError && (
            <ErrorState onRetry={() => void pending.refetch()}>
              We couldn’t load pending approvals.
            </ErrorState>
          )}
          {pending.data && pending.data.length === 0 && (
            <EmptyState icon="✓" tone="positive" title="Nothing awaiting approval">
              Consequential actions (like a bulk memory change from Memories) land here for you to
              approve or reject. Cogeto never runs them on its own.
            </EmptyState>
          )}
          {pending.data && pending.data.length > 0 && (
            <ul className="space-y-3">
              {pending.data.map((a) => (
                <PendingCard key={a.id} session={session} approval={a} />
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === 'history' && (
        <Card>
          {history.isPending && <SkeletonRows rows={2} label="Loading history…" />}
          {history.isError && (
            <ErrorState onRetry={() => void history.refetch()}>
              We couldn’t load the approval history.
            </ErrorState>
          )}
          {history.data && history.data.length === 0 && (
            <EmptyState icon="🗂" title="No decided approvals yet">
              Once you approve or reject an action, it’s recorded here.
            </EmptyState>
          )}
          {history.data && history.data.length > 0 && (
            <ul>
              {history.data.map((a) => (
                <HistoryRow key={a.id} approval={a} />
              ))}
            </ul>
          )}
        </Card>
      )}
    </Shell>
  );
}
