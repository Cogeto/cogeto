import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MemoryListItem } from '@cogeto/shared';
import { approveMemory, fetchMemories, fetchNote, fetchVerification, rejectMemory } from '../api';
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

/**
 * Review (S3-B): the uncertain queue. Every fact the verifier could not fully
 * support waits here for a human verdict — approve (user_approved) or reject
 * (audited removal, decision 0006 ruling 4).
 */
export function Review({ session }: { session: Session }) {
  const { data, isPending, isError } = useQuery({
    queryKey: ['review-queue'],
    queryFn: () => fetchMemories(session, { status: 'uncertain', limit: 50 }),
  });

  return (
    <Shell session={session} title="Review" active="review">
      {isPending && <p className="text-sm text-slate-400">Loading the review queue…</p>}
      {isError && <p className="text-sm text-red-600">Could not load the review queue.</p>}
      {data && data.items.length === 0 && (
        <section className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          Nothing awaits review — every remembered fact passed verification or has your verdict.
        </section>
      )}
      {data && data.items.length > 0 && (
        <ul className="space-y-3">
          {data.items.map((memory) => (
            <ReviewItem key={memory.id} session={session} memory={memory} />
          ))}
        </ul>
      )}
    </Shell>
  );
}
