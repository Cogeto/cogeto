import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DiscoveredPageDto, ResearchCaptureResponse, ResearchRunDto } from '@cogeto/shared';
import { selectTopByScore } from '@cogeto/shared';
import {
  approveResearch,
  cancelResearch,
  captureResearchPages,
  fetchResearchProgress,
  fetchResearchRun,
  markResearchSeen,
} from '../api';
import type { Session } from '../auth/oidc';
import { btnSecondary } from './ui';

/** How many of the most-relevant sources to read automatically (decision 0050). */
const TOP_K = 3;

/**
 * The research flow, inline in chat (decisions 0047 + 0050 + 0058). This card
 * is PROGRESS ONLY: the tap was the approval, the top sources are read
 * automatically, and when the run concludes the answer arrives in the
 * conversation as a persistent assistant message (appended server-side,
 * issue #259) — so the card refreshes the thread and closes itself. It never
 * sends a chat turn on the user's behalf and shows no buttons beyond Cancel
 * while searching. Resumed in-flight runs behave identically: watch, then
 * hand over to the thread.
 */
export function ResearchInline({
  session,
  run: initialRun,
  onClose,
}: {
  session: Session;
  run: ResearchRunDto;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [run, setRun] = useState(initialRun);
  const [results, setResults] = useState<DiscoveredPageDto[] | null>(null);
  const [readUrls, setReadUrls] = useState<string[]>([]);
  const [captured, setCaptured] = useState<ResearchCaptureResponse | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);
  const closedRef = useRef(false);

  const capture = useMutation({
    mutationFn: (urls: string[]) => captureResearchPages(session, run.id, urls),
    onSuccess: (response) => {
      setError(null);
      setCaptured(response);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const approve = useMutation({
    mutationFn: () => approveResearch(session, run.id, run.minimisedQuery.trim()),
    onSuccess: ({ run: updated, search }) => {
      setError(null);
      setRun(updated);
      const found = search.status === 'ok' ? search.results : [];
      setResults(found);
      // Auto-select and read the most relevant sources — no user picking.
      const top = selectTopByScore(found, TOP_K);
      if (top.length > 0) {
        setReadUrls(top);
        capture.mutate(top);
      }
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

  // The tap was the approval: a fresh proposal auto-runs once, on mount.
  // A resumed run (already approved) just watches.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (initialRun.status === 'proposed') approve.mutate();
  }, []);

  const capturedCount = useMemo(
    () => captured?.results.filter((r) => r.status === 'captured').length ?? 0,
    [captured],
  );
  /** Mounted mid-flight (chat resume): pages come from the progress feed. */
  const resumed = initialRun.status !== 'proposed';

  // Honest wait: poll the pipeline progress while any page is extracting.
  const progress = useQuery({
    queryKey: ['research-progress', run.id],
    queryFn: () => fetchResearchProgress(session, run.id),
    enabled: (capturedCount > 0 || resumed) && !cancelled,
    refetchInterval: (query) =>
      query.state.data?.pages.some((p) => p.state === 'processing') ? 2000 : 4000,
  });
  const pages = progress.data?.pages ?? [];
  const extracting = pages.some((p) => p.state === 'processing');
  const totalFacts = pages.reduce((sum, p) => sum + p.factCount, 0);

  // The handover (issue #259): when the run concludes, the answer is already
  // a persistent message in this conversation — refresh the thread and close.
  const runQuery = useQuery({
    queryKey: ['research-run', run.id],
    queryFn: () => fetchResearchRun(session, run.id),
    enabled: (capturedCount > 0 || resumed) && !cancelled,
    refetchInterval: (query) => (query.state.data?.status === 'concluded' ? false : 2500),
  });
  useEffect(() => {
    if (runQuery.data?.status !== 'concluded' || closedRef.current) return;
    closedRef.current = true;
    void queryClient.invalidateQueries({ queryKey: ['chat-messages'] });
    void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    onClose();
  }, [runQuery.data?.status]);

  if (cancelled) {
    return (
      <Frame>
        <p className="text-sm text-slate-600">Cancelled. Nothing more was read.</p>
        <button type="button" className={`${btnSecondary} mt-2`} onClick={onClose}>
          Dismiss
        </button>
      </Frame>
    );
  }

  const disclosedQuery = run.sentQuery ?? run.minimisedQuery;
  const searching = initialRun.status === 'proposed' && results === null && !captured;
  const noResults = results !== null && results.length === 0 && !captured;
  /** A resumed run with nothing captured can never conclude — say so. */
  const resumedEmpty = resumed && progress.isSuccess && pages.length === 0;

  return (
    <Frame>
      {/* What left, and what Cogeto is reading — disclosed, not asked. */}
      <p className="text-xs text-slate-500">
        <span className="font-mono text-[0.64rem] uppercase tracking-[0.12em] text-slate-400">
          Web
        </span>{' '}
        searched <span className="font-medium text-slate-700">“{disclosedQuery}”</span>
        {readUrls.length > 0 && (
          <>
            {' '}
            · reading the top {readUrls.length} source{readUrls.length === 1 ? '' : 's'} by
            relevance
          </>
        )}
      </p>

      {searching && (
        <div className="mt-1 flex items-center justify-between">
          <PulseLine label="Searching the web…" />
          <button
            type="button"
            onClick={() => cancel.mutate()}
            className="text-xs text-slate-400 underline underline-offset-2 hover:text-slate-600"
          >
            Cancel
          </button>
        </div>
      )}

      {noResults && (
        <div className="mt-1 space-y-2">
          <p className="text-sm text-slate-500">
            The engines returned nothing for this query. Try rephrasing your question.
          </p>
          <button type="button" className={btnSecondary} onClick={onClose}>
            Dismiss
          </button>
        </div>
      )}

      {captured && (
        <div className="mt-2 space-y-1">
          {captured.results.map((r) => (
            <p key={r.url} className="truncate text-xs">
              {r.status === 'captured' ? (
                <span className="text-slate-600">✓ {r.url}</span>
              ) : (
                <span className="text-amber-700 dark:text-amber-300">
                  ⨯ {r.url} · skipped ({r.detail})
                </span>
              )}
            </p>
          ))}
        </div>
      )}

      {/* A resumed run: pages and states from the progress feed alone. */}
      {resumed && !captured && pages.length > 0 && (
        <div className="mt-2 space-y-1">
          {pages.map((p) => (
            <p key={p.id} className="truncate text-xs text-slate-600">
              {p.state === 'processing' ? '· ' : '✓ '}
              {p.url}
            </p>
          ))}
        </div>
      )}

      {resumedEmpty ? (
        <div className="mt-1 space-y-2">
          <p className="text-sm text-slate-500">
            This research never read any pages, so there is nothing to wait for.
          </p>
          <button
            type="button"
            className={btnSecondary}
            onClick={() => {
              void markResearchSeen(session, run.id).catch(() => undefined);
              onClose();
            }}
          >
            Dismiss
          </button>
        </div>
      ) : (
        (capturedCount > 0 || (resumed && pages.length > 0)) && (
          <div className="mt-1">
            <PulseLine
              label={
                extracting
                  ? `Extracting and verifying facts…${totalFacts > 0 ? ` ${totalFacts} remembered so far.` : ''}`
                  : 'Writing the answer into this conversation…'
              }
            />
          </div>
        )
      )}

      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
    </Frame>
  );
}

function PulseLine({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-slate-500">
      <span className="inline-flex gap-0.5" aria-hidden="true">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-teal" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-teal [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-teal [animation-delay:300ms]" />
      </span>
      {label}
    </p>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-brand-teal/30 bg-surface p-3 shadow-sm">
      {children}
    </div>
  );
}
