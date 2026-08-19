import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { AdminUserDto, ErasurePreviewDto } from '@cogeto/shared';
import { fetchAdminUsers, fetchErasurePreview, fetchErasureResult, requestErasure } from '../api';
import type { Session } from '../auth/oidc';
import {
  btnDanger,
  btnSecondary,
  Card,
  Drawer,
  EmptyState,
  ErrorState,
  SectionTitle,
  SkeletonRows,
} from '../components/ui';
import { timeAgo } from '../components/status';
import { useApiErrorMessage } from '../i18n/api-error';

/**
 * The operator Users page (issue #638).
 *
 * It exists for ONE act: erasing a departed person's private material, which
 * until now was a pair of curl commands in the operator runbook. Everything
 * else about a user account still lives in Zitadel, and the warning at the
 * top says so, because neither limit is guessable from the page itself.
 */

/** The warning. Deliberately the first thing on the page, and unmissable. */
function Limits() {
  const { t } = useTranslation('users');
  return (
    <div
      role="note"
      className="mb-5 flex gap-3 rounded-lg border border-amber-300 border-l-4 border-l-amber-500 bg-amber-50 p-4 text-amber-900 dark:border-amber-700/70 dark:border-l-amber-500 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.1}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      </svg>
      <div className="text-sm">
        <p className="mb-1.5 font-semibold">{t('limits.title')}</p>
        <ul className="list-disc space-y-1 pl-4">
          <li>{t('limits.signedInOnly')}</li>
          <li>{t('limits.erasesOnly')}</li>
          <li>{t('limits.accountsElsewhere')}</li>
        </ul>
      </div>
    </div>
  );
}

/** The counts an erasure would act on, by kind. */
function Counts({
  rows,
  emptyLabel,
}: {
  rows: { sourceType: string; count: number }[];
  emptyLabel: string;
}) {
  const { t } = useTranslation('users');
  if (rows.length === 0) return <p className="text-sm text-slate-500">{emptyLabel}</p>;
  return (
    <ul className="space-y-1.5">
      {rows.map((row) => (
        <li
          key={row.sourceType}
          className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-sm dark:border-slate-700"
        >
          <span>{t(`sourceType.${row.sourceType}`, { defaultValue: row.sourceType })}</span>
          <span className="tabular-nums text-slate-500">{row.count}</span>
        </li>
      ))}
    </ul>
  );
}

/** Preview → typed confirmation → result, in one drawer. */
function EraseDrawer({
  session,
  user,
  onClose,
}: {
  session: Session;
  user: AdminUserDto;
  onClose: () => void;
}) {
  const { t } = useTranslation('users');
  const queryClient = useQueryClient();
  const errorMessage = useApiErrorMessage(t);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');

  const preview = useQuery({
    queryKey: ['erasure-preview', user.userId],
    queryFn: () => fetchErasurePreview(session, user.userId),
    retry: false,
  });

  const started = useMutation({
    mutationFn: () => requestErasure(session, user.userId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
  });

  // Only polls once a run has been asked for. The worker writes its completion
  // entry when it settles; until then the panel says it is still working.
  const result = useQuery({
    queryKey: ['erasure-result', user.userId],
    queryFn: () => fetchErasureResult(session, user.userId),
    enabled: started.isSuccess,
    refetchInterval: (query) => (query.state.data?.pending === false ? false : 1500),
  });

  // What the administrator must type. The email is what a person recognises;
  // the id is what the request carries.
  const phrase = user.email ?? user.userId;
  const matches = typed.trim().toLowerCase() === phrase.toLowerCase();

  const done = result.data && !result.data.pending;

  return (
    <Drawer title={t('drawer.title', { name: user.displayName })} onClose={onClose}>
      {done ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-teal-ink text-sm font-bold text-white"
            >
              ✓
            </span>
            <div>
              <p className="font-semibold">{t('result.title', { name: user.displayName })}</p>
              <ul className="mt-2 space-y-1 text-sm">
                <li>{t('result.erased', { count: result.data.erased })}</li>
                <li>{t('result.receipts', { count: result.data.receipts })}</li>
                <li>{t('result.kept', { count: result.data.kept })}</li>
                {result.data.keptForSharedFact > 0 && (
                  <li className="text-slate-600 dark:text-slate-400">
                    {t('result.keptForSharedFact', { count: result.data.keptForSharedFact })}
                  </li>
                )}
                <li>{t('result.failed', { count: result.data.failed })}</li>
              </ul>
              <p className="mt-3 text-sm text-slate-500">{t('result.audited')}</p>
              <a
                className="mt-2 inline-block text-sm font-semibold text-brand-teal-ink"
                href="/forgotten"
              >
                {t('result.seeReceipts')}
              </a>
            </div>
          </div>
          <div className="flex justify-end">
            <button type="button" className={btnSecondary} onClick={onClose}>
              {t('common:close')}
            </button>
          </div>
        </div>
      ) : started.isSuccess ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">{t('running')}</p>
      ) : (
        <div className="space-y-5">
          {preview.isPending && <SkeletonRows rows={4} label={t('preview.loading')} />}
          {preview.isError && (
            <ErrorState>{errorMessage(preview.error, 'preview.error')}</ErrorState>
          )}
          {preview.data && (
            <>
              <PreviewBody preview={preview.data} />
              {confirming ? (
                <div className="space-y-3">
                  <label className="block text-sm" htmlFor="erase-confirm">
                    {t('confirm.label', { phrase })}
                  </label>
                  <input
                    id="erase-confirm"
                    autoComplete="off"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder={phrase}
                    className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm dark:border-slate-600 dark:bg-slate-900"
                  />
                  {started.isError && (
                    <ErrorState>{errorMessage(started.error, 'confirm.error')}</ErrorState>
                  )}
                  <div className="flex justify-end gap-2">
                    <button type="button" className={btnSecondary} onClick={onClose}>
                      {t('common:cancel')}
                    </button>
                    <button
                      type="button"
                      className={btnDanger}
                      disabled={!matches || started.isPending}
                      onClick={() => started.mutate()}
                    >
                      {t('confirm.erase')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-end gap-2">
                  <span className="mr-auto text-sm text-slate-500">
                    {t('preview.irreversible')}
                  </span>
                  <button type="button" className={btnSecondary} onClick={onClose}>
                    {t('common:cancel')}
                  </button>
                  <button
                    type="button"
                    className={btnDanger}
                    disabled={preview.data.toEraseTotal === 0}
                    onClick={() => setConfirming(true)}
                  >
                    {t('preview.continue')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}

function PreviewBody({ preview }: { preview: ErasurePreviewDto }) {
  const { t } = useTranslation('users');
  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-red-700 dark:text-red-400">
          {t('preview.willErase', { count: preview.toEraseTotal })}
        </p>
        <Counts rows={preview.toErase} emptyLabel={t('preview.nothingToErase')} />
      </div>
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-brand-teal-ink">
          {t('preview.willKeep', { count: preview.keptTotal })}
        </p>
        <Counts rows={preview.kept} emptyLabel={t('preview.nothingKept')} />
      </div>
      <p className="rounded-md bg-brand-teal-surface px-3 py-2.5 text-sm text-brand-teal-ink">
        {t('preview.sharedRule')}
      </p>
    </div>
  );
}

export function Users({ session }: { session: Session }) {
  const { t } = useTranslation('users');
  const errorMessage = useApiErrorMessage(t);
  const [erasing, setErasing] = useState<AdminUserDto | null>(null);

  const { data, isPending, isError, error } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => fetchAdminUsers(session),
    // A non-administrator gets 403 and retrying cannot change that; the rail
    // hides the section for them, so this is the typed-the-URL case.
    retry: false,
  });

  return (
    <>
      <Card>
        <div className="mb-3">
          <SectionTitle>{t('heading')}</SectionTitle>
        </div>
        <Limits />

        {isPending && <SkeletonRows rows={3} label={t('loading')} />}
        {isError && <ErrorState>{errorMessage(error, 'error')}</ErrorState>}
        {data && data.users.length === 0 && (
          <EmptyState icon="👥" title={t('empty.title')}>
            {t('empty.body')}
          </EmptyState>
        )}

        {data && data.users.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-3 pb-2 text-left font-semibold">{t('column.person')}</th>
                  <th className="px-3 pb-2 text-left font-semibold">{t('column.lastSeen')}</th>
                  <th className="px-3 pb-2 text-left font-semibold">{t('column.sources')}</th>
                  <th className="px-3 pb-2" />
                </tr>
              </thead>
              <tbody>
                {data.users.map((user) => (
                  <tr key={user.userId} className="border-t border-slate-200 dark:border-slate-700">
                    <td className="px-3 py-3">
                      <div className="font-semibold">{user.displayName}</div>
                      <div className="font-mono text-xs text-slate-500">
                        {user.email ?? user.userId}
                      </div>
                    </td>
                    <td className="px-3 py-3 tabular-nums text-slate-600 dark:text-slate-400">
                      {timeAgo(user.lastSeen)}
                    </td>
                    <td className="px-3 py-3 tabular-nums text-slate-600 dark:text-slate-400">
                      {t('column.sourcesValue', {
                        erasable: user.erasableSources,
                        shared: user.sharedSources,
                      })}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <button
                        type="button"
                        className={btnSecondary}
                        disabled={user.isSelf}
                        title={user.isSelf ? t('action.notYourself') : undefined}
                        onClick={() => setErasing(user)}
                      >
                        {t('action.erase')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {erasing && <EraseDrawer session={session} user={erasing} onClose={() => setErasing(null)} />}
    </>
  );
}
