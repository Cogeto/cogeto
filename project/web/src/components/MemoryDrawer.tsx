import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MemoryListItem } from '@cogeto/shared';
import {
  approveMemory,
  editMemory,
  fetchContradictions,
  fetchMemory,
  fetchMemoryChain,
  fetchNote,
  fetchVerification,
  markMemoryOutdated,
  rejectMemory,
  setMemorySensitive,
} from '../api';
import type { Session } from '../auth/oidc';
import { SourceDrawer } from './SourceDrawer';
import { STATUS_CHIP, statusLabel, timeAgo } from './status';

const EDIT_EXPLAINED_KEY = 'cogeto-supersession-explained';

function Chip({ item }: { item: MemoryListItem }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CHIP[item.status]}`}>
      {statusLabel(item.status)}
    </span>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-slate-200 p-3">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h4>
      {children}
    </section>
  );
}

/**
 * The governance drawer (S3-B): full content, allowed actions, verification
 * verdict, provenance, and the supersession history — every trust claim next
 * to its artifact. Server-side guards are the authority; buttons here only
 * hide what is never legal for the current status.
 */
export function MemoryDrawer({
  session,
  memoryId,
  onClose,
  onNavigate,
}: {
  session: Session;
  memoryId: string;
  onClose: () => void;
  /** Re-target the drawer (edit jumps to the successor). */
  onNavigate: (memoryId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [showSource, setShowSource] = useState(false);
  const [showExplainer] = useState(() => !localStorage.getItem(EDIT_EXPLAINED_KEY));

  const memoryQuery = useQuery({
    queryKey: ['memory', memoryId],
    queryFn: () => fetchMemory(session, memoryId),
  });
  const memory = memoryQuery.data;

  const chainQuery = useQuery({
    queryKey: ['memory-chain', memoryId],
    queryFn: () => fetchMemoryChain(session, memoryId),
    enabled: Boolean(memory),
  });
  const verificationQuery = useQuery({
    queryKey: ['verification', memoryId],
    queryFn: () => fetchVerification(session, memoryId),
    enabled: Boolean(memory),
    retry: false, // 404 = user-authored, no verification pass — not an error
  });
  const noteQuery = useQuery({
    queryKey: ['note', memory?.sourceId],
    queryFn: () => fetchNote(session, memory!.sourceId),
    enabled: memory?.sourceType === 'user_note',
  });
  // Contradicted memories show the OTHER side of the conflict right here —
  // the warning chip's promise is both facts, both sources (F2-A).
  const contradictionsQuery = useQuery({
    queryKey: ['contradictions'],
    queryFn: () => fetchContradictions(session),
    enabled: memory?.status === 'contradicted',
  });
  const contradiction = contradictionsQuery.data?.find(
    (relation) => relation.a.id === memoryId || relation.b.id === memoryId,
  );
  const otherSide = contradiction
    ? contradiction.a.id === memoryId
      ? contradiction.b
      : contradiction.a
    : null;
  const otherNoteQuery = useQuery({
    queryKey: ['note', otherSide?.sourceId],
    queryFn: () => fetchNote(session, otherSide!.sourceId),
    enabled: otherSide?.sourceType === 'user_note',
  });

  const refresh = async () => {
    setActionError(null);
    // Chat chips, lists, badges — everything reflects governance immediately.
    await queryClient.invalidateQueries();
  };
  const onError = (error: unknown) =>
    setActionError(error instanceof Error ? error.message : String(error));

  const approve = useMutation({
    mutationFn: () => approveMemory(session, memoryId),
    onSuccess: refresh,
    onError,
  });
  const outdate = useMutation({
    mutationFn: () => markMemoryOutdated(session, memoryId),
    onSuccess: refresh,
    onError,
  });
  const sensitive = useMutation({
    mutationFn: (value: boolean) => setMemorySensitive(session, memoryId, value),
    onSuccess: refresh,
    onError,
  });
  const reject = useMutation({
    mutationFn: () => rejectMemory(session, memoryId),
    onSuccess: async () => {
      await refresh();
      onClose(); // the memory no longer exists
    },
    onError,
  });
  const edit = useMutation({
    mutationFn: (content: string) => editMemory(session, memoryId, content),
    onSuccess: async (result) => {
      localStorage.setItem(EDIT_EXPLAINED_KEY, 'true');
      setEditing(false);
      await refresh();
      // Jump the drawer to the successor — that is the living memory now.
      onNavigate(result.successor.id);
    },
    onError,
  });

  const busy =
    approve.isPending ||
    outdate.isPending ||
    sensitive.isPending ||
    reject.isPending ||
    edit.isPending;

  return (
    <div className="fixed inset-0 z-10" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/30" />
      <aside
        className="absolute right-0 top-0 h-full w-full max-w-lg space-y-3 overflow-y-auto bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Memory</h3>
          <button type="button" onClick={onClose} className="text-sm text-slate-400">
            Close
          </button>
        </div>

        {memoryQuery.isPending && <p className="text-sm text-slate-400">Loading…</p>}
        {memoryQuery.isError && (
          <p className="text-sm text-red-600">Could not load this memory (it may be rejected).</p>
        )}

        {memory && (
          <>
            <p className="whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-sm text-slate-800">
              {memory.content}
            </p>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Chip item={memory} />
              {memory.sensitive && (
                <span className="rounded-full bg-purple-100 px-2 py-0.5 font-semibold text-purple-700">
                  sensitive
                </span>
              )}
              <span className="text-slate-400">scope: {memory.scope}</span>
              {memory.entities.map((entity) => (
                <span key={entity} className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">
                  {entity}
                </span>
              ))}
            </div>
            {(memory.validFrom || memory.validUntil) && (
              <p className="text-xs text-slate-400">
                Valid {memory.validFrom ? new Date(memory.validFrom).toLocaleDateString() : '…'} →{' '}
                {memory.validUntil ? new Date(memory.validUntil).toLocaleDateString() : 'open'}
              </p>
            )}
            {memory.temporalUnresolved.length > 0 && (
              <p className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-700">
                ⚠ Date could not be resolved: {memory.temporalUnresolved.join(', ')}
              </p>
            )}

            {actionError && (
              <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{actionError}</p>
            )}

            <Panel title="Actions">
              <div className="flex flex-wrap gap-2">
                {memory.status === 'uncertain' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => approve.mutate()}
                    className="rounded-md bg-brand-teal px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                  >
                    Approve
                  </button>
                )}
                {memory.status === 'uncertain' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm('Reject and remove this memory? This cannot be undone.'))
                        reject.mutate();
                    }}
                    className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                  >
                    Reject
                  </button>
                )}
                {memory.status !== 'outdated' && memory.status !== 'replaced' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => outdate.mutate()}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 disabled:opacity-40"
                  >
                    Mark outdated
                  </button>
                )}
                {memory.status !== 'replaced' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEditText(memory.content ?? '');
                      setEditing(true);
                    }}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 disabled:opacity-40"
                  >
                    Edit
                  </button>
                )}
                <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={memory.sensitive}
                    disabled={busy}
                    onChange={(e) => sensitive.mutate(e.target.checked)}
                  />
                  Sensitive
                </label>
              </div>
              {editing && (
                <form
                  className="mt-3 space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (editText.trim()) edit.mutate(editText.trim());
                  }}
                >
                  <textarea
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    rows={3}
                    className="w-full resize-y rounded-md border border-slate-300 p-2 text-sm"
                  />
                  {showExplainer && (
                    <p className="text-xs text-slate-500">
                      Saving a correction never rewrites history: it records a new, approved version
                      and keeps this one as its predecessor.
                    </p>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={busy || !editText.trim()}
                      className="rounded-md bg-brand-teal px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                    >
                      Save as correction
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(false)}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-600"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </Panel>

            {memory.status === 'contradicted' && (
              <Panel title="Contradiction">
                {otherSide ? (
                  <div className="space-y-2 text-sm">
                    <p className="text-slate-600">This memory conflicts with:</p>
                    <p className="rounded-md bg-red-50 p-2 text-slate-800">{otherSide.content}</p>
                    {otherNoteQuery.data && (
                      <p className="whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-600">
                        {otherNoteQuery.data.content}
                      </p>
                    )}
                    <a
                      href="/review"
                      className="inline-block rounded-md bg-brand-teal px-3 py-1.5 text-xs font-semibold text-white no-underline"
                    >
                      Resolve in Review
                    </a>
                  </div>
                ) : (
                  <p className="text-sm text-slate-400">
                    {contradictionsQuery.isPending
                      ? 'Loading the conflicting fact…'
                      : 'The conflicting fact is not visible to you (it may have been resolved).'}
                  </p>
                )}
              </Panel>
            )}

            <Panel title="Verification">
              {verificationQuery.data ? (
                <div className="space-y-1 text-sm">
                  <p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        verificationQuery.data.verdict === 'supported'
                          ? 'bg-brand-teal/15 text-brand-teal'
                          : 'bg-amber-100 text-amber-700'
                      }`}
                    >
                      {verificationQuery.data.verdict}
                    </span>
                    <span className="ml-2 text-xs text-slate-400">
                      {verificationQuery.data.promptVersion}
                    </span>
                  </p>
                  <p className="text-slate-600">{verificationQuery.data.reason}</p>
                  {verificationQuery.data.sourceSpan && (
                    <p className="rounded bg-slate-50 p-2 text-xs italic text-slate-500">
                      cited: “{verificationQuery.data.sourceSpan}”
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-slate-400">
                  No verification pass — this version was authored by you.
                </p>
              )}
            </Panel>

            <Panel title="Provenance">
              <p className="text-sm text-slate-600">
                Source: <span className="font-medium">{memory.sourceType.replace('_', ' ')}</span>
                <span className="ml-2 text-xs text-slate-400" title={memory.createdAt}>
                  captured {timeAgo(memory.createdAt)}
                </span>
              </p>
              {noteQuery.data && (
                <p className="mt-2 whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-600">
                  {noteQuery.data.content}
                </p>
              )}
              <button
                type="button"
                onClick={() => setShowSource(true)}
                className="mt-2 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600"
              >
                Open source · delete…
              </button>
            </Panel>

            <Panel title="History">
              {chainQuery.data && chainQuery.data.length > 1 ? (
                <ol className="space-y-2">
                  {chainQuery.data.map((entry, i) => (
                    <li
                      key={entry.id}
                      className={`rounded-md border p-2 text-sm ${
                        entry.id === memory.id ? 'border-brand-teal/50' : 'border-slate-200'
                      }`}
                    >
                      <p className="whitespace-pre-wrap text-slate-700">{entry.content}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                        <Chip item={entry} />
                        <span title={entry.createdAt}>
                          {i === 0 ? 'original' : 'correction'} · {timeAgo(entry.createdAt)}
                        </span>
                        {entry.id === memory.id && <span className="text-brand-teal">viewing</span>}
                      </p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-slate-400">No corrections — this is the original.</p>
              )}
            </Panel>
          </>
        )}
      </aside>
      {memory && showSource && (
        <SourceDrawer
          session={session}
          sourceType={memory.sourceType}
          sourceId={memory.sourceId}
          onClose={() => setShowSource(false)}
          onDeleted={() => {
            // The source, this memory and its siblings are gone; a signed
            // receipt is being confirmed by the worker (Forgotten UI: F1-B).
            setShowSource(false);
            onClose();
          }}
        />
      )}
    </div>
  );
}
