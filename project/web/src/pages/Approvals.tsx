import { useState } from 'react';
import { useConfirm } from '../components/confirm';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import type { ApprovalDto, ApprovalStatus } from '@cogeto/shared';
import { EMAIL_REPLY_DRAFT_ACTION } from '@cogeto/shared';
import {
  confirmApproval,
  fetchApprovalHistory,
  fetchEmailDraft,
  fetchPendingApprovals,
} from '../api';
import type { Session } from '../auth/oidc';
import { invalidateAfterApproval } from '../query-invalidation';
import { formatDateTime } from '../i18n/format';
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
/** Approval STATUS is an API value; only its display name is translated. */
function ApprovalPill({ status }: { status: ApprovalStatus }) {
  const { t } = useTranslation('approvals');
  return <Pill tone={STATUS_TONE[status]}>{t(`status.${status}`)}</Pill>;
}

/**
 * Reply-draft presentation: the finalised draft, with copy /
 * download.eml / open-in-mail-client affordances. Cogeto NEVER sends — every
 * path here hands the draft to the user's own client.
 */
function EmailDraftPanel({ session, approvalId }: { session: Session; approvalId: string }) {
  const { t } = useTranslation('approvals');
  const [open, setOpen] = useState(false);
  const draft = useQuery({
    queryKey: ['email-draft', approvalId],
    queryFn: () => fetchEmailDraft(session, approvalId),
    enabled: open,
  });

  const downloadEml = () => {
    if (!draft.data) return;
    const blob = new Blob([draft.data.eml], { type: 'message/rfc822' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reply-${approvalId.slice(0, 8)}.eml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mt-3 rounded-md border border-slate-200 bg-surface p-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-xs font-medium text-brand-teal-ink dark:text-brand-teal hover:underline"
      >
        {open ? t('draft.hide') : t('draft.view')}
      </button>
      {open && draft.data && (
        <div className="mt-2 space-y-2">
          <div className="text-xs text-slate-500">
            {t('draft.to')} <span className="font-mono">{draft.data.to}</span>
            <br />
            {t('draft.subject', { subject: draft.data.subject })}
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-xs text-slate-700">
            {draft.data.body}
          </pre>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(draft.data!.body)}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
            >
              {t('draft.copyBody')}
            </button>
            <button
              type="button"
              onClick={downloadEml}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
            >
              {t('draft.downloadEml')}
            </button>
            <a
              href={draft.data.mailto}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
            >
              {t('draft.openInClient')}
            </a>
          </div>
          <p className="text-xs text-amber-700 dark:text-amber-300">
            <Trans i18nKey="draft.neverSends" ns="approvals" components={{ b: <strong /> }} />
          </p>
        </div>
      )}
    </div>
  );
}

function PendingCard({ session, approval }: { session: Session; approval: ApprovalDto }) {
  const { t } = useTranslation('approvals');
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') => confirmApproval(session, approval.id, decision),
    onSuccess: async () => {
      setError(null);
      await invalidateAfterApproval(queryClient); //
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <li className="rounded-lg border border-slate-200 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-800">{approval.summary}</p>
          <p className="mt-0.5 text-xs text-slate-400">
            {t('pending.requestedBy', {
              action: approval.actionType,
              who: approval.requestedBy ?? t('pending.unknownRequester'),
            })}
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

      {approval.actionType === EMAIL_REPLY_DRAFT_ACTION && (
        <EmailDraftPanel session={session} approvalId={approval.id} />
      )}

      {approval.expiresAt && (
        <p className="mt-2 text-xs text-slate-400">
          {t('pending.expires', { when: formatDateTime(approval.expiresAt) })}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-300">{error}</p>}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={decide.isPending}
          onClick={() => decide.mutate('approve')}
          className={btnPrimary}
        >
          {t('pending.approve')}
        </button>
        <button
          type="button"
          disabled={decide.isPending}
          onClick={() => {
            void confirm({
              title: t('pending.rejectConfirm'),
              confirmLabel: t('pending.reject'),
            }).then((asked) => {
              if (asked) decide.mutate('reject');
            });
          }}
          className={btnDanger}
        >
          {t('pending.reject')}
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-400">{t('pending.serverSideNote')}</p>
    </li>
  );
}

function HistoryRow({ session, approval }: { session: Session; approval: ApprovalDto }) {
  const { t } = useTranslation('approvals');
  const when = approval.executedAt ?? approval.decidedAt;
  return (
    <li className="border-b border-slate-100 py-2 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-slate-700">{approval.summary}</p>
          <p className="text-xs text-slate-400">
            {approval.actionType}
            {approval.decidedBy ? t('history.decidedBy', { who: approval.decidedBy }) : ''}
            {when ? ` · ${timeAgo(when)}` : ''}
          </p>
          {approval.result && (
            <p className="mt-0.5 text-xs text-brand-teal-ink dark:text-brand-teal">
              {approval.result}
            </p>
          )}
        </div>
        <ApprovalPill status={approval.status} />
      </div>
      {approval.actionType === EMAIL_REPLY_DRAFT_ACTION && approval.status === 'executed' && (
        <EmailDraftPanel session={session} approvalId={approval.id} />
      )}
    </li>
  );
}

/** Pending Approvals: the sole approval surface + read-only history. */
export function Approvals({ session }: { session: Session }) {
  const { t } = useTranslation('approvals');
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
    <Shell session={session} title={t('navigation:section.approvals')} active="approvals">
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          {
            key: 'pending',
            label: (
              <span className="flex items-center gap-1.5">
                {t('tab.pending')}
                {(pending.data?.length ?? 0) > 0 && (
                  <CountBadge count={pending.data!.length} label={t('tab.awaitingNoun')} />
                )}
              </span>
            ),
          },
          { key: 'history', label: t('tab.history') },
        ]}
      />

      {tab === 'pending' && (
        <Card>
          {pending.isPending && <SkeletonRows rows={2} label={t('pending.loading')} />}
          {pending.isError && (
            <ErrorState onRetry={() => void pending.refetch()}>{t('pending.error')}</ErrorState>
          )}
          {pending.data && pending.data.length === 0 && (
            <EmptyState icon="✓" tone="positive" title={t('pending.empty.title')}>
              {t('pending.empty.body')}
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
          {history.isPending && <SkeletonRows rows={2} label={t('history.loading')} />}
          {history.isError && (
            <ErrorState onRetry={() => void history.refetch()}>{t('history.error')}</ErrorState>
          )}
          {history.data && history.data.length === 0 && (
            <EmptyState icon="🗂" title={t('history.empty.title')}>
              {t('history.empty.body')}
            </EmptyState>
          )}
          {history.data && history.data.length > 0 && (
            <ul>
              {history.data.map((a) => (
                <HistoryRow key={a.id} session={session} approval={a} />
              ))}
            </ul>
          )}
        </Card>
      )}
    </Shell>
  );
}
