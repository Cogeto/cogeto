import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AuditEntryDto } from '@cogeto/shared';
import { fetchAudit } from '../api';
import type { Session } from '../auth/oidc';
import { Shell } from '../components/Shell';
import { timeAgo } from '../components/status';

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
  const link = entityLink(entry);
  const detailKeys = entry.detail ? Object.entries(entry.detail) : [];
  return (
    <li className="border-b border-slate-100 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-slate-700">{entry.action}</span>
        <span className="text-xs text-slate-400">by {entry.actor}</span>
        <span className="ml-auto text-xs text-slate-400" title={entry.createdAt}>
          {timeAgo(entry.createdAt)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span className="rounded-full bg-slate-100 px-2 py-0.5">{entry.entityType}</span>
        {link ? (
          <a href={link} className="font-mono text-brand-teal hover:underline">
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
    </li>
  );
}

/** The read-only audit trail (§A.8/§B.1, O1-C): who did what, filterable + paged. */
export function Audit({ session }: { session: Session }) {
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
  const { data, isPending, isError } = useQuery({
    queryKey: ['audit', params],
    queryFn: () => fetchAudit(session, params),
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const reset = () => setPage(0);

  return (
    <Shell session={session} title="Audit" active="audit">
      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Audit trail
          </h2>
          {data && <span className="text-xs text-slate-400">{data.total} entries</span>}
          <span className="ml-auto text-xs text-slate-400">read-only · append-only</span>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <input
            value={actor}
            onChange={(e) => {
              setActor(e.target.value);
              reset();
            }}
            placeholder="actor…"
            className="w-32 rounded-md border border-slate-300 px-2 py-1.5"
          />
          <input
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              reset();
            }}
            placeholder="action…"
            className="w-40 rounded-md border border-slate-300 px-2 py-1.5"
          />
          <input
            value={entityType}
            onChange={(e) => {
              setEntityType(e.target.value);
              reset();
            }}
            placeholder="entity type…"
            className="w-36 rounded-md border border-slate-300 px-2 py-1.5"
          />
          <label className="flex items-center gap-1 text-slate-500">
            from
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
            to
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

        {isPending && <p className="text-sm text-slate-400">Loading…</p>}
        {isError && <p className="text-sm text-red-600">Could not load the audit trail.</p>}
        {data && data.items.length === 0 && (
          <p className="text-sm text-slate-400">No audit entries match these filters.</p>
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
              Newer
            </button>
            <span>
              page {page + 1} of {pages}
            </span>
            <button
              type="button"
              disabled={page + 1 >= pages}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-md border border-slate-300 px-2 py-1 disabled:opacity-40"
            >
              Older
            </button>
          </div>
        )}
      </section>
    </Shell>
  );
}
