import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MemoryListItem, MemoryScope, MemoryStatus } from '@cogeto/shared';
import { BULK_OUTDATE_ACTION, MEMORY_SCOPES, MEMORY_STATUSES } from '@cogeto/shared';
import { createApproval, fetchMe, fetchMemories } from '../api';
import type { Session } from '../auth/oidc';
import { statusLabel, timeAgo } from './status';
import {
  btnPrimary,
  btnSecondary,
  Card,
  EmptyState,
  EntityChip,
  ErrorState,
  SectionTitle,
  SensitiveBadge,
  SharedBadge,
  SkeletonRows,
  StatusChip,
} from './ui';

const PAGE_SIZE = 25;

function MemoryRow({
  memory,
  myUserId,
  onOpen,
  onEntity,
  selecting,
  selected,
  onToggleSelect,
}: {
  memory: MemoryListItem;
  myUserId?: string;
  onOpen: () => void;
  onEntity: (entity: string) => void;
  selecting: boolean;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const mine = memory.ownerId === myUserId;
  return (
    <li
      className={`rounded-md border transition-colors hover:border-brand-teal/60 ${
        selected ? 'border-brand-teal bg-brand-teal/5' : 'border-slate-200'
      }`}
    >
      <div className="flex gap-2 px-3 py-2">
        {selecting && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            className="mt-1 shrink-0"
            aria-label={`Select: ${memory.content?.slice(0, 60) ?? 'memory'}`}
          />
        )}
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={selecting ? onToggleSelect : onOpen}
            className="block w-full text-left text-sm text-slate-800 transition-colors hover:text-brand-teal-ink dark:hover:text-brand-teal"
          >
            {memory.content}
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <StatusChip status={memory.status} />
            {memory.sensitive && <SensitiveBadge />}
            {memory.scope === 'shared' && (
              <SharedBadge owner={!mine ? (memory.ownerName ?? 'member') : undefined} />
            )}
            {memory.entities.map((entity) => (
              <EntityChip key={entity} name={entity} onClick={() => onEntity(entity)} />
            ))}
            <span className="ml-auto text-slate-400" title={memory.createdAt}>
              {timeAgo(memory.createdAt)}
            </span>
          </div>
        </div>
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
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [requested, setRequested] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const clearSelection = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const requestBulkOutdate = useMutation({
    mutationFn: () => createApproval(session, BULK_OUTDATE_ACTION, { memoryIds: [...selected] }),
    onSuccess: async (approval) => {
      setRequested(approval.summary);
      clearSelection();
      await queryClient.invalidateQueries({ queryKey: ['pending-approvals'] });
    },
  });

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
  // Cached by the Shell — used only to mark which shared rows are someone else's.
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => fetchMe(session) });

  const resetPage = () => setPage(0);
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <SectionTitle>Memories</SectionTitle>
        {data && <span className="text-xs text-slate-400">{data.total} on record</span>}
        <button
          type="button"
          onClick={() => (selecting ? clearSelection() : setSelecting(true))}
          className={`${btnSecondary} ml-auto`}
        >
          {selecting ? 'Cancel' : 'Select'}
        </button>
      </div>

      {requested && (
        <p className="mb-3 rounded-md bg-brand-teal-surface dark:bg-brand-teal/15 px-3 py-2 text-sm text-brand-teal-ink dark:text-brand-teal">
          Requested: “{requested}”. Decide it under{' '}
          <a href="/approvals" className="font-semibold underline">
            Approvals
          </a>
          . It runs only after you approve it there.
        </p>
      )}

      {selecting && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-brand-teal/40 bg-brand-teal/5 px-3 py-2 text-sm">
          <span className="font-medium text-slate-700">{selected.size} selected</span>
          <span className="text-xs text-slate-500">
            Bulk changes are consequential. They create a pending approval, not an instant edit.
          </span>
          {requestBulkOutdate.isError && (
            <span className="text-xs text-red-600 dark:text-red-300">
              {requestBulkOutdate.error instanceof Error
                ? requestBulkOutdate.error.message
                : 'Request failed'}
            </span>
          )}
          <button
            type="button"
            disabled={selected.size === 0 || requestBulkOutdate.isPending}
            onClick={() => requestBulkOutdate.mutate()}
            className={`${btnPrimary} ml-auto`}
          >
            {requestBulkOutdate.isPending ? 'Requesting…' : 'Request “Mark outdated” approval'}
          </button>
        </div>
      )}

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

      {isPending && <SkeletonRows rows={4} label="Loading memories…" />}
      {isError && <ErrorState>We couldn’t load your memories just now.</ErrorState>}
      {data &&
        data.items.length === 0 &&
        (data.total === 0 && !q && !status && !scope && !entity && !sensitiveOnly ? (
          <EmptyState icon="🧠" title="Nothing remembered yet">
            A memory is a single verifiable fact Cogeto extracted from something you captured.
            Capture a note above and watch it move through extraction and verification.
          </EmptyState>
        ) : (
          <EmptyState icon="🔍" title="No memories match these filters">
            Try clearing the search or status filter.
          </EmptyState>
        ))}
      {data && data.items.length > 0 && (
        <ul className="space-y-2">
          {data.items.map((memory) => (
            <MemoryRow
              key={memory.id}
              memory={memory}
              myUserId={me?.userId}
              onOpen={() => onOpen(memory.id)}
              onEntity={(name) => {
                setEntity(name);
                resetPage();
              }}
              selecting={selecting}
              selected={selected.has(memory.id)}
              onToggleSelect={() => toggleSelect(memory.id)}
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
    </Card>
  );
}
