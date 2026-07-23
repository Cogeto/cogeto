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
import { invalidateAfterContradiction, invalidateAfterGovernance } from '../query-invalidation';
import { Shell } from '../components/Shell';
import { timeAgo } from '../components/status';
import {
  btnDanger,
  btnPrimary,
  btnSecondary,
  EmptyState,
  ErrorState,
  SkeletonRows,
  Tabs,
  VerdictChip,
} from '../components/ui';

/** Highlights the cited span inside the source text when it is present. */
function SourceWithSpan({ source, span }: { source: string; span: string | null }) {
  if (!span) return <p className="whitespace-pre-wrap">{source}</p>;
  const at = source.indexOf(span);
  if (at < 0) return <p className="whitespace-pre-wrap">{source}</p>;
  return (
    <p className="whitespace-pre-wrap">
      {source.slice(0, at)}
      <mark className="rounded bg-amber-100 px-0.5 dark:bg-amber-400/20 dark:text-amber-100">
        {span}
      </mark>
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
    await invalidateAfterGovernance(queryClient); // QS-36
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
    <li className="rounded-lg border border-slate-200 bg-surface p-4 shadow-sm">
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Extracted fact
          </h3>
          <p className="rounded-md bg-slate-50 p-2 text-sm text-slate-800">{memory.content}</p>
          {verification.data && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <VerdictChip verdict={verification.data.verdict} />
              <span>{verification.data.reason}</span>
            </div>
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
      {error && (
        <p className="mt-2 rounded-md border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => approve.mutate()}
          className={btnPrimary}
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
          className={btnDanger}
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

/** One side of a contradiction: the fact and its source, span highlighted.
 * The newer side carries a teal accent, the earlier a slate one, so the two
 * claims read as a comparison at a glance. */
function ContradictionSide({
  session,
  label,
  accent,
  memory,
}: {
  session: Session;
  label: string;
  accent: 'newer' | 'earlier';
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
  const isNewer = accent === 'newer';
  return (
    <div
      className={`rounded-lg border-l-4 bg-surface p-3 shadow-sm ${
        isNewer ? 'border-l-brand-teal border-slate-200' : 'border-l-slate-400 border-slate-200'
      } border`}
    >
      <p
        className={`mb-1.5 text-[11px] font-bold uppercase tracking-wide ${
          isNewer ? 'text-brand-teal-ink dark:text-brand-teal' : 'text-slate-500'
        }`}
      >
        {label}
      </p>
      <p className="rounded-md bg-slate-50 p-2 text-sm font-medium text-slate-800">
        {memory.content}
      </p>
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
      // Chat chips, lists, badges — the contradiction-affected queries (QS-36).
      await invalidateAfterContradiction(queryClient);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });
  const busy = resolve.isPending;

  return (
    <li className="rounded-lg border border-red-200 bg-red-50/40 p-4 shadow-sm dark:border-red-500/30 dark:bg-red-500/10">
      <p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-red-700 dark:text-red-300">
        <span aria-hidden="true">⚠</span>
        These two facts disagree
      </p>
      <div className="relative grid gap-3 md:grid-cols-2">
        <ContradictionSide
          session={session}
          label="Newer fact"
          accent="newer"
          memory={contradiction.a}
        />
        <span
          className="pointer-events-none absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 rounded-full border border-red-200 dark:border-red-500/30 bg-surface px-2 py-0.5 text-[11px] font-bold uppercase text-red-600 dark:text-red-300 md:block"
          aria-hidden="true"
        >
          vs
        </span>
        <ContradictionSide
          session={session}
          label="Earlier fact"
          accent="earlier"
          memory={contradiction.b}
        />
      </div>
      {contradiction.reason && (
        <p className="mt-2 text-xs text-slate-500">
          <span className="font-medium text-slate-600">Why it was flagged:</span>{' '}
          {contradiction.reason}
        </p>
      )}
      {error && (
        <p className="mt-2 rounded-md border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
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
              className={btnPrimary}
            >
              Save both corrections
            </button>
            <button type="button" onClick={() => setCorrecting(false)} className={btnSecondary}>
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
            className={btnPrimary}
          >
            The newer fact is right
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => resolve.mutate({ action: 'confirm_b' })}
            className={btnPrimary}
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
            className={btnSecondary}
          >
            Correct both
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => resolve.mutate({ action: 'dismiss' })}
            className={btnSecondary}
            title="They don't actually conflict. Restore both as they were"
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

  return (
    <Shell session={session} title="Review" active="review" width="wide">
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          {
            key: 'uncertain',
            label: `Uncertain${uncertain.data ? ` (${uncertain.data.total})` : ''}`,
          },
          {
            key: 'contradicted',
            label: `Contradicted${contradictions.data ? ` (${contradictions.data.length})` : ''}`,
          },
        ]}
      />

      {tab === 'uncertain' && (
        <>
          {uncertain.isPending && <SkeletonRows rows={3} label="Loading the review queue…" />}
          {uncertain.isError && (
            <ErrorState onRetry={() => void uncertain.refetch()}>
              We couldn’t load the review queue.
            </ErrorState>
          )}
          {uncertain.data && uncertain.data.items.length === 0 && (
            <EmptyState icon="✓" tone="positive" title="Nothing awaits review">
              Every remembered fact passed verification or already has your verdict. Cogeto only
              asks when it isn’t sure.
            </EmptyState>
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
          {contradictions.isPending && <SkeletonRows rows={2} label="Loading contradictions…" />}
          {contradictions.isError && (
            <ErrorState onRetry={() => void contradictions.refetch()}>
              We couldn’t load the contradiction queue.
            </ErrorState>
          )}
          {contradictions.data && contradictions.data.length === 0 && (
            <EmptyState icon="🤝" tone="positive" title="No open contradictions">
              Your memories agree with each other. When two facts about the same thing disagree,
              they’ll appear here side by side to resolve.
            </EmptyState>
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
