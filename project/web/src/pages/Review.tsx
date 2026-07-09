import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ContradictionDto, MemoryListItem, ResolveContradictionRequest } from '@cogeto/shared';
import {
  approveMemory,
  fetchContradictions,
  fetchMemories,
  fetchNote,
  fetchVerification,
  rejectMemory,
  resolveContradiction,
} from '../api';
import type { Session } from '../auth/oidc';
import { Shell } from '../components/Shell';
import { timeAgo } from '../components/status';

/** Highlights the cited span inside the source text when it is present. */
function SourceWithSpan({ source, span }: { source: string; span: string | null }) {
  if (!span) return <p className="whitespace-pre-wrap">{source}</p>;
  const at = source.indexOf(span);
  if (at < 0) return <p className="whitespace-pre-wrap">{source}</p>;
  return (
    <p className="whitespace-pre-wrap">
      {source.slice(0, at)}
      <mark className="rounded bg-amber-100 px-0.5">{span}</mark>
      {source.slice(at + span.length)}
    </p>
  );
}

function ReviewItem({ session, memory }: { session: Session; memory: MemoryListItem }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const verification = useQuery({
    queryKey: ['verification', memory.id],
    queryFn: () => fetchVerification(session, memory.id),
    retry: false,
  });
  const note = useQuery({
    queryKey: ['note', memory.sourceId],
    queryFn: () => fetchNote(session, memory.sourceId),
    enabled: memory.sourceType === 'user_note',
  });

  const settle = async () => {
    setError(null);
    await queryClient.invalidateQueries();
  };
  const onError = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const approve = useMutation({
    mutationFn: () => approveMemory(session, memory.id),
    onSuccess: settle,
    onError,
  });
  const reject = useMutation({
    mutationFn: () => rejectMemory(session, memory.id),
    onSuccess: settle,
    onError,
  });
  const busy = approve.isPending || reject.isPending;

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Extracted fact
          </h3>
          <p className="rounded-md bg-slate-50 p-2 text-sm text-slate-800">{memory.content}</p>
          {verification.data && (
            <p className="mt-2 text-xs text-slate-500">
              <span className="font-semibold text-amber-700">{verification.data.verdict}</span> —{' '}
              {verification.data.reason}
            </p>
          )}
        </div>
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Source
          </h3>
          <div className="rounded-md bg-slate-50 p-2 text-sm text-slate-600">
            {note.data ? (
              <SourceWithSpan
                source={note.data.content}
                span={verification.data?.sourceSpan ?? null}
              />
            ) : (
              <p className="text-slate-400">
                {memory.sourceType === 'user_note' ? 'Loading…' : `(${memory.sourceType})`}
              </p>
            )}
          </div>
        </div>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => approve.mutate()}
          className="rounded-md bg-brand-teal px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
        >
          Approve
        </button>
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
        <span className="ml-auto text-xs text-slate-400" title={memory.createdAt}>
          extracted {timeAgo(memory.createdAt)}
        </span>
      </div>
    </li>
  );
}

/** One side of a contradiction: the fact and its source, span highlighted. */
function ContradictionSide({
  session,
  label,
  memory,
}: {
  session: Session;
  label: string;
  memory: MemoryListItem;
}) {
  const verification = useQuery({
    queryKey: ['verification', memory.id],
    queryFn: () => fetchVerification(session, memory.id),
    retry: false,
  });
  const note = useQuery({
    queryKey: ['note', memory.sourceId],
    queryFn: () => fetchNote(session, memory.sourceId),
    enabled: memory.sourceType === 'user_note',
  });
  return (
    <div className="rounded-md border border-slate-200 p-3">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</h3>
      <p className="rounded-md bg-slate-50 p-2 text-sm text-slate-800">{memory.content}</p>
      <p className="mt-1 text-xs text-slate-400" title={memory.createdAt}>
        {memory.kind ? `${memory.kind.replace('_', ' ')} · ` : ''}captured{' '}
        {timeAgo(memory.createdAt)}
      </p>
      <div className="mt-2 rounded-md bg-slate-50 p-2 text-xs text-slate-600">
        {note.data ? (
          <SourceWithSpan source={note.data.content} span={verification.data?.sourceSpan ?? null} />
        ) : (
          <p className="text-slate-400">
            {memory.sourceType === 'user_note' ? 'Loading source…' : `(${memory.sourceType})`}
          </p>
        )}
      </div>
    </div>
  );
}

function ContradictionItem({
  session,
  contradiction,
}: {
  session: Session;
  contradiction: ContradictionDto;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [aText, setAText] = useState('');
  const [bText, setBText] = useState('');

  const resolve = useMutation({
    mutationFn: (body: ResolveContradictionRequest) =>
      resolveContradiction(session, contradiction.id, body),
    onSuccess: async () => {
      setError(null);
      setCorrecting(false);
      // Chat chips, lists, badges — governance reflects immediately.
      await queryClient.invalidateQueries();
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });
  const busy = resolve.isPending;

  return (
    <li className="rounded-lg border border-red-200 bg-white p-4 shadow-sm">
      <div className="grid gap-3 md:grid-cols-2">
        <ContradictionSide session={session} label="Newer fact" memory={contradiction.a} />
        <ContradictionSide session={session} label="Earlier fact" memory={contradiction.b} />
      </div>
      {error && <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      {correcting ? (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (aText.trim() && bText.trim())
              resolve.mutate({ action: 'correct', aContent: aText.trim(), bContent: bText.trim() });
          }}
        >
          <label className="block text-xs font-semibold text-slate-500">
            Corrected newer fact
            <textarea
              value={aText}
              onChange={(e) => setAText(e.target.value)}
              rows={2}
              className="mt-1 w-full resize-y rounded-md border border-slate-300 p-2 text-sm font-normal"
            />
          </label>
          <label className="block text-xs font-semibold text-slate-500">
            Corrected earlier fact
            <textarea
              value={bText}
              onChange={(e) => setBText(e.target.value)}
              rows={2}
              className="mt-1 w-full resize-y rounded-md border border-slate-300 p-2 text-sm font-normal"
            />
          </label>
          <p className="text-xs text-slate-500">
            Corrections never rewrite history: each saves a new, approved version and keeps the old
            one as its predecessor.
          </p>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || !aText.trim() || !bText.trim()}
              className="rounded-md bg-brand-teal px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
            >
              Save both corrections
            </button>
            <button
              type="button"
              onClick={() => setCorrecting(false)}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-600"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => resolve.mutate({ action: 'confirm_a' })}
            className="rounded-md bg-brand-teal px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
          >
            The newer fact is right
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => resolve.mutate({ action: 'confirm_b' })}
            className="rounded-md bg-brand-teal px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
          >
            The earlier fact is right
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setAText(contradiction.a.content ?? '');
              setBText(contradiction.b.content ?? '');
              setCorrecting(true);
            }}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 disabled:opacity-40"
          >
            Correct both
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => resolve.mutate({ action: 'dismiss' })}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 disabled:opacity-40"
            title="They don't actually conflict — restore both as they were"
          >
            Not a conflict
          </button>
          <span className="ml-auto text-xs text-slate-400" title={contradiction.detectedAt}>
            detected {timeAgo(contradiction.detectedAt)}
          </span>
        </div>
      )}
    </li>
  );
}

type ReviewTab = 'uncertain' | 'contradicted';

/**
 * Review: two queues awaiting a human verdict. Uncertain — facts the verifier
 * could not fully support (approve / reject, S3-B). Contradicted — pairs
 * reconciliation flagged (confirm one / correct both / dismiss, F2-A,
 * decision 0010 ruling 3).
 */
export function Review({ session }: { session: Session }) {
  // ?tab=contradicted — dreaming digest conflict lines land on the right queue.
  const [tab, setTab] = useState<ReviewTab>(() =>
    new URLSearchParams(window.location.search).get('tab') === 'contradicted'
      ? 'contradicted'
      : 'uncertain',
  );

  const uncertain = useQuery({
    queryKey: ['review-queue'],
    // Own facts only (O2-B): you review your own uncertain extractions — a
    // peer's shared uncertain fact is theirs to approve, never yours.
    queryFn: () => fetchMemories(session, { status: 'uncertain', mine: true, limit: 50 }),
  });
  const contradictions = useQuery({
    queryKey: ['contradictions'],
    queryFn: () => fetchContradictions(session),
  });

  const tabClass = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-semibold ${
      active ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
    }`;

  return (
    <Shell session={session} title="Review" active="review">
      <div className="flex w-fit gap-1 rounded-lg bg-slate-200/70 p-1">
        <button
          type="button"
          className={tabClass(tab === 'uncertain')}
          onClick={() => setTab('uncertain')}
        >
          Uncertain{uncertain.data ? ` (${uncertain.data.total})` : ''}
        </button>
        <button
          type="button"
          className={tabClass(tab === 'contradicted')}
          onClick={() => setTab('contradicted')}
        >
          Contradicted{contradictions.data ? ` (${contradictions.data.length})` : ''}
        </button>
      </div>

      {tab === 'uncertain' && (
        <>
          {uncertain.isPending && (
            <p className="text-sm text-slate-400">Loading the review queue…</p>
          )}
          {uncertain.isError && (
            <p className="text-sm text-red-600">Could not load the review queue.</p>
          )}
          {uncertain.data && uncertain.data.items.length === 0 && (
            <section className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
              Nothing awaits review — every remembered fact passed verification or has your verdict.
            </section>
          )}
          {uncertain.data && uncertain.data.items.length > 0 && (
            <ul className="space-y-3">
              {uncertain.data.items.map((memory) => (
                <ReviewItem key={memory.id} session={session} memory={memory} />
              ))}
            </ul>
          )}
        </>
      )}

      {tab === 'contradicted' && (
        <>
          {contradictions.isPending && (
            <p className="text-sm text-slate-400">Loading contradictions…</p>
          )}
          {contradictions.isError && (
            <p className="text-sm text-red-600">Could not load the contradiction queue.</p>
          )}
          {contradictions.data && contradictions.data.length === 0 && (
            <section className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
              No open contradictions — your memories agree with each other.
            </section>
          )}
          {contradictions.data && contradictions.data.length > 0 && (
            <ul className="space-y-3">
              {contradictions.data.map((contradiction) => (
                <ContradictionItem
                  key={contradiction.id}
                  session={session}
                  contradiction={contradiction}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </Shell>
  );
}
