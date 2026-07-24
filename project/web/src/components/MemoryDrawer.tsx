import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  adoptMemoryAsTask,
  approveMemory,
  changeMemoryScope,
  editMemory,
  fetchContradictions,
  fetchMe,
  fetchMemory,
  fetchMemoryChain,
  fetchNote,
  fetchVerification,
  markMemoryOutdated,
  rejectMemory,
  setMemorySensitive,
} from '../api';
import type { Session } from '../auth/oidc';
import { invalidateAfterGovernance } from '../query-invalidation';
import { SourceDrawer } from './SourceDrawer';
import { timeAgo } from './status';
import {
  btnDanger,
  btnPrimary,
  btnSecondary,
  Drawer,
  EntityChip,
  ErrorState,
  PrivateTag,
  SensitiveBadge,
  SharedBadge,
  SkeletonRows,
  StatusChip,
  VerdictChip,
} from './ui';

const EDIT_EXPLAINED_KEY = 'cogeto-supersession-explained';

/** Deep-link into the time-travel view for a subject, optionally at an instant. */
function timelineHref(subject: string, at?: string | null): string {
  const params = new URLSearchParams({ subject });
  if (at) {
    params.set('mode', 'at');
    params.set('at', at);
  }
  return `/timeline?${params.toString()}`;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
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
  // Ownership drives which actions are offered (O2-B). The server enforces
  // owner-only regardless; the UI hides what a non-owner may never do and
  // explains why. `me` is cached by the Shell — this is a free read.
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => fetchMe(session) });
  const isMine = memory ? memory.ownerId === me?.userId : false;

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
    // Chat chips, lists, badges — the governance-affected queries only (QS-36).
    await invalidateAfterGovernance(queryClient);
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
  const scope = useMutation({
    mutationFn: (value: 'private' | 'shared') => changeMemoryScope(session, memoryId, value),
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
  // "Make this a task" (P6.5, decision 0054): the deliberate adoption of an
  // observed obligation. Any owned memory qualifies; the server derives the
  // task through the existing engine and audits it as user-adopted.
  const [adoptedTaskTitle, setAdoptedTaskTitle] = useState<string | null>(null);
  const adopt = useMutation({
    mutationFn: () => adoptMemoryAsTask(session, memoryId),
    onSuccess: async (result) => {
      setAdoptedTaskTitle(result.title);
      await refresh();
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
    scope.isPending ||
    reject.isPending ||
    edit.isPending ||
    adopt.isPending;

  return (
    <>
      <Drawer title="Memory" onClose={onClose}>
        {memoryQuery.isPending && <SkeletonRows rows={4} label="Loading memory…" />}
        {memoryQuery.isError && (
          <ErrorState>This memory couldn’t be loaded. It may have been rejected.</ErrorState>
        )}

        {memory && (
          <>
            <p className="whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-base leading-relaxed text-slate-800">
              {memory.content}
            </p>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <StatusChip status={memory.status} />
              {memory.sensitive && <SensitiveBadge />}
              {memory.scope === 'shared' ? <SharedBadge /> : <PrivateTag />}
              {!isMine && (
                <span className="text-slate-400">
                  owned by {memory.ownerName ?? 'another member'}
                </span>
              )}
              {memory.entities.map((entity) => (
                <EntityChip
                  key={entity}
                  name={entity}
                  title={`Time-travel ${entity}`}
                  onClick={() => {
                    window.location.href = timelineHref(entity);
                  }}
                />
              ))}
            </div>
            {(memory.validFrom || memory.validUntil) && (
              <p className="text-xs text-slate-400">
                Valid {memory.validFrom ? new Date(memory.validFrom).toLocaleDateString() : '…'} →{' '}
                {memory.validUntil ? new Date(memory.validUntil).toLocaleDateString() : 'open'}
              </p>
            )}
            {memory.temporalUnresolved.length > 0 && (
              <p className="rounded-md bg-amber-50 dark:bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
                ⚠ Date could not be resolved: {memory.temporalUnresolved.join(', ')}
              </p>
            )}

            {actionError && (
              <p className="rounded-md border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                {actionError}
              </p>
            )}

            <Panel title="Actions">
              {!isMine ? (
                <p className="text-sm text-slate-500">
                  This memory is shared with your organization by{' '}
                  <span className="font-medium">{memory.ownerName ?? 'another member'}</span>. You
                  can read it, but only its owner can approve, edit, change its scope, or delete it.
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    {memory.status === 'uncertain' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => approve.mutate()}
                        className={btnPrimary}
                      >
                        Approve
                      </button>
                    )}
                    {memory.status === 'uncertain' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm('Reject and remove this memory? This cannot be undone.')
                          )
                            reject.mutate();
                        }}
                        className={btnDanger}
                      >
                        Reject
                      </button>
                    )}
                    {memory.status !== 'outdated' && memory.status !== 'replaced' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => outdate.mutate()}
                        className={btnSecondary}
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
                        className={btnSecondary}
                      >
                        Edit
                      </button>
                    )}
                    {memory.status !== 'replaced' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => adopt.mutate()}
                        title="Turn this memory into a task you own. Observed obligations never become tasks on their own."
                        className={btnSecondary}
                      >
                        Make this a task
                      </button>
                    )}
                    <label
                      className="ml-auto flex items-center gap-1.5 text-xs text-slate-600"
                      title="Shared facts are visible to everyone in your organization."
                    >
                      Scope
                      <select
                        value={memory.scope}
                        disabled={busy}
                        onChange={(e) => scope.mutate(e.target.value as 'private' | 'shared')}
                        className="rounded-md border border-slate-300 px-2 py-0.5"
                      >
                        <option value="private">private</option>
                        <option value="shared">shared</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={memory.sensitive}
                        disabled={busy}
                        onChange={(e) => sensitive.mutate(e.target.checked)}
                      />
                      Sensitive
                    </label>
                  </div>
                  {adoptedTaskTitle !== null && (
                    <p className="mt-2 rounded-md bg-emerald-50 dark:bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
                      This is now your task, derived from this memory.{' '}
                      <a href="/tasks" className="font-medium underline">
                        Open Tasks
                      </a>
                    </p>
                  )}
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
                          Saving a correction never rewrites history: it records a new, approved
                          version and keeps this one as its predecessor.
                        </p>
                      )}
                      <div className="flex gap-2">
                        <button
                          type="submit"
                          disabled={busy || !editText.trim()}
                          className={btnPrimary}
                        >
                          Save as correction
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing(false)}
                          className={btnSecondary}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                </>
              )}
            </Panel>

            {memory.status === 'contradicted' && (
              <Panel title="Contradiction">
                {otherSide ? (
                  <div className="space-y-2 text-sm">
                    <p className="text-slate-600">This memory conflicts with:</p>
                    <p className="rounded-md bg-red-50 dark:bg-red-500/10 p-2 text-slate-800">
                      {otherSide.content}
                    </p>
                    {otherNoteQuery.data && (
                      <p className="whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-600">
                        {otherNoteQuery.data.content}
                      </p>
                    )}
                    <a href="/review" className={`${btnPrimary} no-underline`}>
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
                  <p className="flex items-center gap-2">
                    <VerdictChip verdict={verificationQuery.data.verdict} />
                    <span className="text-xs text-slate-400">
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
                  No verification pass. This version was authored by you.
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
              {isMine ? (
                <button
                  type="button"
                  onClick={() => setShowSource(true)}
                  className={`${btnSecondary} mt-2`}
                >
                  Open source · delete…
                </button>
              ) : (
                <p className="mt-2 text-xs text-slate-400">
                  The source is private to its owner. Deletion is owner-only.
                </p>
              )}
            </Panel>

            <Panel title="History">
              {memory.entities.length > 0 && (
                <a
                  href={timelineHref(memory.entities[0]!, memory.validFrom ?? memory.createdAt)}
                  className={`${btnSecondary} mb-2`}
                >
                  Open timeline for {memory.entities[0]}
                </a>
              )}
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
                        <StatusChip status={entry.status} />
                        <span title={entry.createdAt}>
                          {i === 0 ? 'original' : 'correction'} · {timeAgo(entry.createdAt)}
                        </span>
                        {entry.id === memory.id && (
                          <span className="font-semibold text-brand-teal-ink dark:text-brand-teal">
                            viewing
                          </span>
                        )}
                      </p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-slate-400">No corrections. This is the original.</p>
              )}
            </Panel>
          </>
        )}
      </Drawer>
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
    </>
  );
}
