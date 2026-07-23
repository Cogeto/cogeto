import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  DiscoveredPageDto,
  ResearchAnswerDto,
  ResearchCaptureResponse,
  ResearchRunDto,
} from '@cogeto/shared';
import {
  approveResearch,
  cancelResearch,
  captureResearchPages,
  fetchResearchProgress,
  synthesiseResearch,
} from '../api';
import type { Session } from '../auth/oidc';
import { btnDanger, btnPrimary, btnSecondary } from './ui';
import { ResearchAnswer } from './ResearchAnswer';

/**
 * The research flow, inline in chat (decision 0047). The SAME gate as the
 * Research page — this component only calls the same owner-gated endpoints;
 * approval remains the server-side research_run transition, and nothing
 * leaves before it. The flow: approve-what-leaves → pick pages → fetch →
 * honest extraction progress → conclude. When the pages yield structured
 * facts, `onConclude` fires and chat asks the topic as a normal turn — the
 * answer streams grounded in the fresh web memories, persisted with
 * per-claim chips. When they yield none, the page-grounded synthesis renders
 * here as the honest fallback.
 */
export function ResearchInline({
  session,
  run: initialRun,
  onConclude,
  onClose,
}: {
  session: Session;
  run: ResearchRunDto;
  /** Extraction finished with facts — chat asks `topic` as a visible turn. */
  onConclude: (topic: string) => void;
  onClose: () => void;
}) {
  const [run, setRun] = useState(initialRun);
  const [editedQuery, setEditedQuery] = useState(initialRun.minimisedQuery);
  const [results, setResults] = useState<DiscoveredPageDto[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [captured, setCaptured] = useState<ResearchCaptureResponse | null>(null);
  const [fallbackAnswer, setFallbackAnswer] = useState<ResearchAnswerDto | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const concludedRef = useRef(false);

  const approve = useMutation({
    mutationFn: () => approveResearch(session, run.id, editedQuery.trim()),
    onSuccess: ({ run: updated, search }) => {
      setError(null);
      setRun(updated);
      setResults(search.status === 'ok' ? search.results : []);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const cancel = useMutation({
    mutationFn: () => cancelResearch(session, run.id),
    onSuccess: () => {
      setError(null);
      setCancelled(true);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const capture = useMutation({
    mutationFn: () => captureResearchPages(session, run.id, [...selected]),
    onSuccess: (response) => {
      setError(null);
      setCaptured(response);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const synthesise = useMutation({
    mutationFn: () => synthesiseResearch(session, run.id),
    onSuccess: (dto) => {
      setError(null);
      setFallbackAnswer(dto);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const capturedCount = useMemo(
    () => captured?.results.filter((r) => r.status === 'captured').length ?? 0,
    [captured],
  );

  // The honest wait: poll the run's pipeline progress while any page is
  // still extracting. Facts arrive through the normal worker pipeline.
  const progress = useQuery({
    queryKey: ['research-progress', run.id],
    queryFn: () => fetchResearchProgress(session, run.id),
    enabled: capturedCount > 0 && !fallbackAnswer && !cancelled,
    refetchInterval: (query) =>
      query.state.data?.pages.some((p) => p.state === 'processing') ? 2000 : false,
  });
  const pages = progress.data?.pages ?? [];
  const extracting =
    capturedCount > 0 && (progress.isPending || pages.some((p) => p.state === 'processing'));
  const totalFacts = pages.reduce((sum, p) => sum + p.factCount, 0);
  const settled = capturedCount > 0 && !progress.isPending && !extracting;

  // Conclude exactly once: facts → chat asks the topic (grounded, persisted);
  // no facts → the page-grounded synthesis is the honest fallback. The ref
  // guard (not the dependency list) is what enforces the once — settling is
  // the only trigger that matters.
  useEffect(() => {
    if (!settled || concludedRef.current || fallbackAnswer || cancelled) return;
    concludedRef.current = true;
    if (totalFacts > 0) {
      onConclude(run.intent);
    } else {
      synthesise.mutate();
    }
  }, [settled, totalFacts, fallbackAnswer, cancelled]);

  if (cancelled) {
    return (
      <Frame>
        <p className="text-sm text-slate-600">Cancelled. Nothing was sent.</p>
        <button type="button" className={`${btnSecondary} mt-2`} onClick={onClose}>
          Dismiss
        </button>
      </Frame>
    );
  }

  const gateOpen = run.status === 'proposed';
  const queryEdited = editedQuery.trim() !== run.minimisedQuery;

  return (
    <Frame>
      {gateOpen && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Approve what leaves
          </p>
          <p className="text-xs text-slate-500">
            Nothing has been sent. This is the exact query that will reach public search engines if
            you approve. Edit it freely first.
          </p>
          {run.minimisedQuery !== run.proposedQuery && (
            <p className="text-xs">
              <span className="text-slate-400">− proposed: </span>
              <span className="text-slate-400 line-through decoration-slate-300">
                {run.proposedQuery}
              </span>
            </p>
          )}
          <input
            value={editedQuery}
            onChange={(e) => setEditedQuery(e.target.value)}
            className="w-full rounded-md border border-brand-teal/50 bg-brand-teal/5 px-3 py-2 text-sm font-medium text-slate-800"
            aria-label="The query that will be sent"
          />
          <p className="rounded bg-slate-50 px-2 py-1 text-xs text-slate-600">
            {run.minimiseReason}
            {queryEdited && ' · You edited the query. Your text is what will be sent.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={btnPrimary}
              disabled={!editedQuery.trim() || approve.isPending}
              onClick={() => approve.mutate()}
            >
              {approve.isPending ? 'Searching…' : 'Approve & search'}
            </button>
            <button
              type="button"
              className={btnDanger}
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              Cancel, send nothing
            </button>
          </div>
        </div>
      )}

      {run.status === 'approved' && results !== null && !captured && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Results: pick the pages worth reading
          </p>
          {results.length === 0 ? (
            <p className="text-sm text-slate-500">
              The engines returned nothing for this query. You can start again with different
              wording, or use the Research page.
            </p>
          ) : (
            <>
              <p className="text-xs text-slate-500">
                Sent query: <span className="font-medium text-slate-700">{run.sentQuery}</span>,
                recorded on this run and on every memory this research produces.
              </p>
              <ul className="max-h-64 space-y-2 overflow-y-auto">
                {results.map((r) => (
                  <li key={r.url} className="flex items-start gap-2 rounded-md bg-slate-50 p-2">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={selected.has(r.url)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(r.url);
                        else next.delete(r.url);
                        setSelected(next);
                      }}
                      aria-label={`Select ${r.title || r.url}`}
                    />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-800">
                        {r.title || r.url}
                      </p>
                      <p className="break-all text-xs text-brand-teal-ink dark:text-brand-teal">
                        {r.url}
                      </p>
                      {r.snippet && <p className="text-xs text-slate-500">{r.snippet}</p>}
                    </div>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className={btnPrimary}
                disabled={selected.size === 0 || capture.isPending}
                onClick={() => capture.mutate()}
              >
                {capture.isPending
                  ? 'Fetching…'
                  : `Fetch ${selected.size || ''} selected page${selected.size === 1 ? '' : 's'}`}
              </button>
            </>
          )}
        </div>
      )}

      {captured && !fallbackAnswer && (
        <div className="space-y-1">
          {captured.results.map((r) => (
            <p key={r.url} className="text-xs">
              {r.status === 'captured' ? (
                <span className="text-slate-600">✓ {r.url}</span>
              ) : (
                <span className="text-amber-700 dark:text-amber-300">
                  ⨯ {r.url} · skipped ({r.detail})
                </span>
              )}
            </p>
          ))}
          {extracting && (
            <p className="flex items-center gap-2 text-sm text-slate-500">
              <span className="inline-flex gap-0.5" aria-hidden="true">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-teal" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-teal [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-teal [animation-delay:300ms]" />
              </span>
              Extracting and verifying facts from {capturedCount} page
              {capturedCount === 1 ? '' : 's'}…
              {totalFacts > 0 && ` ${totalFacts} remembered so far.`}
            </p>
          )}
          {settled && totalFacts > 0 && (
            <p className="text-sm text-slate-600">
              ✓ {capturedCount} page{capturedCount === 1 ? '' : 's'} captured, {totalFacts} fact
              {totalFacts === 1 ? '' : 's'} remembered. Answering from them now.
            </p>
          )}
          {synthesise.isPending && (
            <p className="text-sm text-slate-500">
              The pages didn’t yield structured facts. Synthesising directly from the fetched pages
              instead…
            </p>
          )}
        </div>
      )}

      {fallbackAnswer && (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">
            The pages didn’t yield structured facts, so this answer is grounded directly in the
            fetched pages, every claim traceable:
          </p>
          <ResearchAnswer answer={fallbackAnswer} />
          <button type="button" className={btnSecondary} onClick={onClose}>
            Done
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-brand-teal/30 bg-surface p-3 shadow-sm">
      {children}
    </div>
  );
}
