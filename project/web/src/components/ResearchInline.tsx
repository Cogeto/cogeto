import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  DiscoveredPageDto,
  ResearchAnswerDto,
  ResearchCaptureResponse,
  ResearchRunDto,
} from '@cogeto/shared';
import { selectTopByScore } from '@cogeto/shared';
import {
  approveResearch,
  cancelResearch,
  captureResearchPages,
  fetchResearchProgress,
  synthesiseResearch,
} from '../api';
import type { Session } from '../auth/oidc';
import { btnSecondary } from './ui';
import { ResearchAnswer } from './ResearchAnswer';

/** How many of the most-relevant sources to read automatically (decision 0050). */
const TOP_K = 3;

/**
 * The research flow, inline in chat (decisions 0047 + 0050). Frictionless: the
 * "Research this on the web" tap WAS the approval, so this auto-approves the
 * minimised query, auto-selects the top {@link TOP_K} sources by SearXNG
 * relevance score, and reads them — no gate, no page-picking. The exact query
 * that left and the sources read are disclosed here and recorded in every
 * derived memory's provenance (the honesty mechanism is preserved; only the
 * pre-send preview is gone). When the pages yield facts, chat asks the topic as
 * a grounded turn; when they don't, the page-grounded synthesis is the fallback.
 * The standalone Research page keeps the full edit/approve gate for control.
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
  const [results, setResults] = useState<DiscoveredPageDto[] | null>(null);
  const [readUrls, setReadUrls] = useState<string[]>([]);
  const [captured, setCaptured] = useState<ResearchCaptureResponse | null>(null);
  const [fallbackAnswer, setFallbackAnswer] = useState<ResearchAnswerDto | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const concludedRef = useRef(false);
  const startedRef = useRef(false);

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

  const synthesise = useMutation({
    mutationFn: () => synthesiseResearch(session, run.id),
    onSuccess: (dto) => {
      setError(null);
      setFallbackAnswer(dto);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  // The tap was the approval: auto-run the whole flow once, on mount.
  useEffect(() => {
    if (startedRef.current || run.status !== 'proposed') return;
    startedRef.current = true;
    approve.mutate();
  }, []);

  const capturedCount = useMemo(
    () => captured?.results.filter((r) => r.status === 'captured').length ?? 0,
    [captured],
  );

  // Honest wait: poll the run's pipeline progress while any page is extracting.
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

  // Conclude once: facts → chat asks the topic (grounded); no facts → synthesise.
  useEffect(() => {
    if (!settled || concludedRef.current || fallbackAnswer || cancelled) return;
    concludedRef.current = true;
    if (totalFacts > 0) onConclude(run.intent);
    else synthesise.mutate();
  }, [settled, totalFacts, fallbackAnswer, cancelled]);

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
  const searching = results === null && !captured;
  const noResults = results !== null && results.length === 0 && !captured;

  return (
    <Frame>
      {/* What left, and what Cogeto is reading — disclosed, not asked. */}
      {!fallbackAnswer && (
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
      )}

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

      {captured && !fallbackAnswer && (
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
          {extracting && (
            <PulseLine
              label={`Extracting and verifying facts from ${capturedCount} page${
                capturedCount === 1 ? '' : 's'
              }…${totalFacts > 0 ? ` ${totalFacts} remembered so far.` : ''}`}
            />
          )}
          {settled && totalFacts > 0 && (
            <p className="text-sm text-slate-600">
              ✓ {capturedCount} page{capturedCount === 1 ? '' : 's'} read, {totalFacts} fact
              {totalFacts === 1 ? '' : 's'} remembered. Answering from them now.
            </p>
          )}
          {synthesise.isPending && (
            <p className="text-sm text-slate-500">
              The pages didn’t yield structured facts. Synthesising directly from them instead…
            </p>
          )}
        </div>
      )}

      {fallbackAnswer && (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">
            The pages didn’t yield structured facts, so this answer is grounded directly in the
            sources Cogeto read, every claim traceable:
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
