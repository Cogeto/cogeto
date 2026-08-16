import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { AuditEntryDto } from '@cogeto/shared';
import { fetchAudit } from '../api';
import type { Session } from '../auth/oidc';
import { Shell } from '../components/Shell';
import { Card, EmptyState, ErrorState, SectionTitle, SkeletonRows } from '../components/ui';
import { timeAgo } from '../components/status';
import { useApiErrorMessage } from '../i18n/api-error';

const PAGE_SIZE = 50;

/** Resolves an audit entry to the SPA route for its subject, where one exists. */
function entityLink(entry: AuditEntryDto): string | null {
  switch (entry.entityType) {
    case 'memory':
      return `/memories?open=${entry.entityId}`;
    case 'approval':
      return '/approvals';
    case 'deletion_receipt':
      return '/forgotten';
    case 'user_settings':
      return '/settings';
    case 'dead_letter':
      return '/system';
    default:
      return null;
  }
}

function AuditRow({ entry }: { entry: AuditEntryDto }) {
  const { t } = useTranslation('audit');
  const link = entityLink(entry);
  const detailKeys = entry.detail ? Object.entries(entry.detail) : [];
  return (
    <li className="border-b border-slate-100 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-slate-700">{entry.action}</span>
        <span className="text-xs text-slate-400">{t('row.byActor', { actor: entry.actor })}</span>
        <span className="ml-auto text-xs text-slate-400" title={entry.createdAt}>
          {timeAgo(entry.createdAt)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">
          {entry.entityType}
        </span>
        {link ? (
          <a
            href={link}
            className="font-mono text-brand-teal-ink dark:text-brand-teal hover:underline"
          >
            {entry.entityId.length > 24 ? `${entry.entityId.slice(0, 24)}…` : entry.entityId}
          </a>
        ) : (
          <span className="font-mono text-slate-400">
            {entry.entityId.length > 24 ? `${entry.entityId.slice(0, 24)}…` : entry.entityId}
          </span>
        )}
      </div>
      {detailKeys.length > 0 && (
        <p className="mt-1 break-words text-xs text-slate-400">
          {detailKeys
            .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
            .join(' · ')}
        </p>
      )}
      {entry.detailWithheld && (
        <p className="mt-1 text-xs italic text-slate-400">{t('row.detailsWithheld')}</p>
      )}
    </li>
  );
}

/** The read-only audit trail (/spec §11.1): who did what, filterable + paged. */
export function Audit({ session }: { session: Session }) {
  const { t } = useTranslation('audit');
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);

  const params = {
    actor: actor || undefined,
    action: action || undefined,
    entityType: entityType || undefined,
    from: from ? new Date(from).toISOString() : undefined,
    to: to ? new Date(to).toISOString() : undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const { data, isPending, isError, error } = useQuery({
    queryKey: ['audit', params],
    queryFn: () => fetchAudit(session, params),
    // A non-administrator gets 403 here and retrying cannot change that
    // (issue #633). The rail hides the section for them, so this is the
    // typed-the-URL case: say why once, in their own language.
    retry: false,
  });
  // Renders the server's own `auth.roleRequired` code as translated copy
  // rather than the page's generic "could not load" line.
  const errorMessage = useApiErrorMessage(t);
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const reset = () => setPage(0);

  return (
    <Shell session={session} title={t('navigation:section.audit')} active="audit">
      <Card>
        <div className="mb-3 flex items-center gap-2">
          <SectionTitle>{t('heading')}</SectionTitle>
          {data && (
            <span className="text-xs text-slate-400">{t('entryCount', { count: data.total })}</span>
          )}
          <span className="ml-auto text-xs text-slate-400">{t('appendOnly')}</span>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <input
            value={actor}
            onChange={(e) => {
              setActor(e.target.value);
              reset();
            }}
            placeholder={t('filter.actor')}
            className="w-32 rounded-md border border-slate-300 px-2 py-1.5"
          />
          <input
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              reset();
            }}
            placeholder={t('filter.action')}
            className="w-40 rounded-md border border-slate-300 px-2 py-1.5"
          />
          <input
            value={entityType}
            onChange={(e) => {
              setEntityType(e.target.value);
              reset();
            }}
            placeholder={t('filter.entityType')}
            className="w-36 rounded-md border border-slate-300 px-2 py-1.5"
          />
          <label className="flex items-center gap-1 text-slate-500">
            {t('filter.from')}
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                reset();
              }}
              className="rounded-md border border-slate-300 px-2 py-1.5"
            />
          </label>
          <label className="flex items-center gap-1 text-slate-500">
            {t('filter.to')}
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                reset();
              }}
              className="rounded-md border border-slate-300 px-2 py-1.5"
            />
          </label>
        </div>

        {isPending && <SkeletonRows rows={5} label={t('loading')} />}
        {isError && <ErrorState>{errorMessage(error, 'error')}</ErrorState>}
        {data && data.items.length === 0 && (
          <EmptyState icon="🗒" title={t('empty.title')}>
            {t('empty.body')}
          </EmptyState>
        )}
        {data && data.items.length > 0 && (
          <ul>
            {data.items.map((entry) => (
              <AuditRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}

        {data && pages > 1 && (
          <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
            <button
              type="button"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className="rounded-md border border-slate-300 px-2 py-1 disabled:opacity-40"
            >
              {t('memories:list.pager.newer')}
            </button>
            <span>{t('memories:list.pager.position', { page: page + 1, pages })}</span>
            <button
              type="button"
              disabled={page + 1 >= pages}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-md border border-slate-300 px-2 py-1 disabled:opacity-40"
            >
              {t('memories:list.pager.older')}
            </button>
          </div>
        )}
      </Card>
    </Shell>
  );
}
