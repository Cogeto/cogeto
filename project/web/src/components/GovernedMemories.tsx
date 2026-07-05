import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MemoryListItem, MemoryScope, MemoryStatus } from '@cogeto/shared';
import { MEMORY_SCOPES, MEMORY_STATUSES } from '@cogeto/shared';
import { fetchMemories } from '../api';
import type { Session } from '../auth/oidc';
import { STATUS_CHIP, statusLabel, timeAgo } from './status';

const PAGE_SIZE = 25;

function MemoryRow({
  memory,
  onOpen,
  onEntity,
}: {
  memory: MemoryListItem;
  onOpen: () => void;
  onEntity: (entity: string) => void;
}) {
  return (
    <li
      className="cursor-pointer rounded-md border border-slate-200 px-3 py-2 hover:border-brand-teal/60"
      onClick={onOpen}
    >
      <p className="text-sm text-slate-800">{memory.content}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
        <span className={`rounded-full px-2 py-0.5 font-semibold ${STATUS_CHIP[memory.status]}`}>
          {statusLabel(memory.status)}
        </span>
        {memory.sensitive && (
          <span className="rounded-full bg-purple-100 px-2 py-0.5 font-semibold text-purple-700">
            sensitive
          </span>
        )}
        {memory.entities.map((entity) => (
          <button
            key={entity}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEntity(entity);
            }}
            className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600 hover:bg-slate-200"
          >
            {entity}
          </button>
        ))}
        <span className="ml-auto text-slate-400" title={memory.createdAt}>
          {timeAgo(memory.createdAt)}
        </span>
      </div>
    </li>
  );
}

/** The governed memory list (S3-B): search, filters, pagination, drawer on click. */
export function GovernedMemories({
  session,
  onOpen,
}: {
  session: Session;
  onOpen: (memoryId: string) => void;
}) {
  const [q, setQ] = useState('');
  // ?status=outdated — dreaming digest lines deep-link into a filtered view.
  const [status, setStatus] = useState<MemoryStatus | ''>(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('status');
    return fromUrl && (MEMORY_STATUSES as readonly string[]).includes(fromUrl)
      ? (fromUrl as MemoryStatus)
      : '';
  });
  const [scope, setScope] = useState<MemoryScope | ''>('');
  const [sensitiveOnly, setSensitiveOnly] = useState(false);
  const [entity, setEntity] = useState('');
  const [page, setPage] = useState(0);

  const params = {
    q: q || undefined,
    status: status || undefined,
    scope: scope || undefined,
    sensitiveOnly,
    entity: entity || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const { data, isPending, isError } = useQuery({
    queryKey: ['memories', params],
    queryFn: () => fetchMemories(session, params),
  });

  const resetPage = () => setPage(0);
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Memories</h2>
        {data && <span className="text-xs text-slate-400">{data.total} on record</span>}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            resetPage();
          }}
          placeholder="Search memories…"
          className="min-w-48 flex-1 rounded-md border border-slate-300 px-3 py-1.5 focus:border-brand-teal focus:outline-none"
        />
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as MemoryStatus | '');
            resetPage();
          }}
          className="rounded-md border border-slate-300 px-2 py-1.5 text-xs text-slate-600"
        >
          <option value="">any status</option>
          {MEMORY_STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
        <select
          value={scope}
          onChange={(e) => {
            setScope(e.target.value as MemoryScope | '');
            resetPage();
          }}
          className="rounded-md border border-slate-300 px-2 py-1.5 text-xs text-slate-600"
        >
          <option value="">any scope</option>
          {MEMORY_SCOPES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          value={entity}
          onChange={(e) => {
            setEntity(e.target.value);
            resetPage();
          }}
          placeholder="entity…"
          className="w-28 rounded-md border border-slate-300 px-2 py-1.5 text-xs"
        />
        <label className="flex items-center gap-1 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={sensitiveOnly}
            onChange={(e) => {
              setSensitiveOnly(e.target.checked);
              resetPage();
            }}
          />
          sensitive only
        </label>
      </div>

      {isPending && <p className="text-sm text-slate-400">Loading…</p>}
      {isError && <p className="text-sm text-red-600">Could not load memories.</p>}
      {data && data.items.length === 0 && (
        <p className="text-sm text-slate-400">
          {data.total === 0 && !q && !status && !scope && !entity && !sensitiveOnly
            ? 'Nothing remembered yet. Capture a note above to see the pipeline work.'
            : 'No memories match these filters.'}
        </p>
      )}
      {data && data.items.length > 0 && (
        <ul className="space-y-2">
          {data.items.map((memory) => (
            <MemoryRow
              key={memory.id}
              memory={memory}
              onOpen={() => onOpen(memory.id)}
              onEntity={(name) => {
                setEntity(name);
                resetPage();
              }}
            />
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
  );
}
