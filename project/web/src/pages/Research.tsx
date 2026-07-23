import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DiscoveredPageDto,
  ResearchAnswerDto,
  ResearchCaptureResponse,
  ResearchRunDto,
} from '@cogeto/shared';
import { ResearchAnswer } from '../components/ResearchAnswer';
import {
  approveResearch,
  cancelResearch,
  captureResearchPages,
  fetchResearchRuns,
  proposeResearch,
  synthesiseResearch,
} from '../api';
import type { Session } from '../auth/oidc';
import { Shell } from '../components/Shell';
import {
  btnDanger,
  btnPrimary,
  btnSecondary,
  Card,
  EmptyState,
  ErrorState,
  Pill,
  SectionTitle,
  SkeletonRows,
} from '../components/ui';
import type { Tone } from '../components/status';

const STATUS_TONE: Record<ResearchRunDto['status'], Tone> = {
  proposed: 'warning',
  approved: 'positive',
  cancelled: 'neutral',
};

/**
 * The research surface (Priority 5 Part B; decisions 0044/0045). The flow IS
 * the privacy mechanism: propose → the gate shows exactly what would leave
 * (minimised, with the reason) → the user edits/approves/cancels → only then
 * does discovery run → the user picks pages → capture → a cited synthesis.
 */
export function Research({ session }: { session: Session }) {
  const queryClient = useQueryClient();
  const [intent, setIntent] = useState('');
  const [run, setRun] = useState<ResearchRunDto | null>(null);
  const [editedQuery, setEditedQuery] = useState('');
  const [results, setResults] = useState<DiscoveredPageDto[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [captured, setCaptured] = useState<ResearchCaptureResponse | null>(null);
  const [answer, setAnswer] = useState<ResearchAnswerDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runsQuery = useQuery({
    queryKey: ['research-runs'],
    queryFn: () => fetchResearchRuns(session),
  });
  const refreshRuns = () => queryClient.invalidateQueries({ queryKey: ['research-runs'] });

  const reset = () => {
    setRun(null);
    setResults(null);
    setSelected(new Set());
    setCaptured(null);
    setAnswer(null);
    setError(null);
  };

  /** Load a proposed run into the gate — the chat handoff and the list's
   * "Review & approve" both land here. Nothing is sent by opening it. */
  const resume = (r: ResearchRunDto) => {
    reset();
    setIntent(r.intent);
    setRun(r);
    setEditedQuery(r.minimisedQuery);
  };

  // Arriving from chat: the reply says "open the Research page to edit or
  // approve it" — honour that by auto-opening the MOST RECENT proposed run
  // when the page loads idle.
  const latestProposed = runsQuery.data?.find((r) => r.status === 'proposed');
  useEffect(() => {
    if (!run && !answer && intent === '' && latestProposed) resume(latestProposed);
    // Intentionally keyed on the id alone: resuming must not re-fire on every
    // state change while the user is mid-flow.
  }, [latestProposed?.id]);

  const propose = useMutation({
    mutationFn: () => proposeResearch(session, intent.trim()),
    onSuccess: async (dto) => {
      setError(null);
      setRun(dto);
      setEditedQuery(dto.minimisedQuery);
      await refreshRuns();
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const approve = useMutation({
    mutationFn: () => approveResearch(session, run!.id, editedQuery.trim()),
    onSuccess: async ({ run: updated, search }) => {
      setError(null);
      setRun(updated);
      setResults(search.status === 'ok' ? search.results : []);
      await refreshRuns();
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const cancel = useMutation({
    mutationFn: (runId: string) => cancelResearch(session, runId),
    onSuccess: async () => {
      reset();
      await refreshRuns();
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const capture = useMutation({
    mutationFn: () => captureResearchPages(session, run!.id, [...selected]),
    onSuccess: (response) => {
      setError(null);
      setCaptured(response);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const synthesise = useMutation({
    mutationFn: () => synthesiseResearch(session, run!.id),
    onSuccess: async (dto) => {
      setError(null);
      setAnswer(dto);
      await refreshRuns();
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const capturedCount = useMemo(
    () => captured?.results.filter((r) => r.status === 'captured').length ?? 0,
    [captured],
  );

  const gateOpen = run && run.status === 'proposed';
  const searched = run && run.status === 'approved' && results !== null;
  const queryEdited = run ? editedQuery.trim() !== run.minimisedQuery : false;

  return (
    <Shell session={session} title="Research" active="research">
      <Card>
        <SectionTitle>Ask the web, on your terms</SectionTitle>
        <p className="mb-2 text-xs text-slate-500">
          Research is explicitly invoked and honest about what leaves: Cogeto minimises the query,
          shows you exactly what would be sent, and sends nothing until you approve it. Fetched
          pages become inspectable, deletable web memories.
        </p>
        <div className="flex gap-2">
          <input
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && intent.trim() && !run) propose.mutate();
            }}
            placeholder="e.g. GDPR consent requirements when migrating a CRM"
            className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
            disabled={!!run}
          />
          {!run ? (
            <button
              type="button"
              className={btnPrimary}
              disabled={!intent.trim() || propose.isPending}
              onClick={() => propose.mutate()}
            >
              {propose.isPending ? 'Preparing…' : 'Prepare research'}
            </button>
          ) : (
            <button type="button" className={btnSecondary} onClick={reset}>
              New research
            </button>
          )}
        </div>
      </Card>

      {gateOpen && (
        <Card>
          <SectionTitle>Approve what leaves</SectionTitle>
          <div className="space-y-2">
            <p className="text-xs text-slate-500">
              Nothing has been sent. This is the exact query that will reach public search engines
              if you approve. Edit it freely first.
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
            <div className="flex gap-2">
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
                onClick={() => cancel.mutate(run.id)}
              >
                Cancel, send nothing
              </button>
            </div>
          </div>
        </Card>
      )}

      {searched && (
        <Card>
          <SectionTitle>Results: pick the pages worth reading</SectionTitle>
          {results.length === 0 && (
            <EmptyState title="No results">
              The engines returned nothing for this query. Start a new research with different
              wording.
            </EmptyState>
          )}
          {results.length > 0 && (
            <>
              <p className="mb-2 text-xs text-slate-500">
                Sent query: <span className="font-medium text-slate-700">{run.sentQuery}</span>,
                recorded on this run and on every memory this research produces.
              </p>
              <ul className="space-y-2">
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
              <div className="mt-3 flex items-center gap-3">
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
                <span className="text-xs text-slate-400">
                  Pages are fetched by this instance, robots-respecting, never rendered.
                </span>
              </div>
            </>
          )}
          {captured && (
            <div className="mt-3 space-y-1">
              {captured.results.map((r) => (
                <p key={r.url} className="text-xs">
                  {r.status === 'captured' ? (
                    <span className="text-slate-600">✓ {r.url} · captured, extracting…</span>
                  ) : (
                    <span className="text-amber-700 dark:text-amber-300">
                      ⨯ {r.url} · skipped ({r.detail})
                    </span>
                  )}
                </p>
              ))}
              {capturedCount > 0 && (
                <button
                  type="button"
                  className={`${btnPrimary} mt-2`}
                  disabled={synthesise.isPending}
                  onClick={() => synthesise.mutate()}
                >
                  {synthesise.isPending ? 'Synthesising…' : 'Synthesise a cited answer'}
                </button>
              )}
            </div>
          )}
        </Card>
      )}

      {answer && (
        <Card>
          <SectionTitle>Answer: every claim traceable</SectionTitle>
          <ResearchAnswer answer={answer} />
          <p className="mt-2 text-xs text-slate-400">
            Web citations link to the page as fetched; the facts persist as web memories you can
            inspect and delete from the Memories page.
          </p>
        </Card>
      )}

      {error && <ErrorState>{error}</ErrorState>}

      <Card>
        <SectionTitle>Past research</SectionTitle>
        {runsQuery.isPending && <SkeletonRows rows={3} label="Loading research runs…" />}
        {runsQuery.isError && <ErrorState>We couldn’t load past research.</ErrorState>}
        {runsQuery.data && runsQuery.data.length === 0 && (
          <EmptyState title="No research yet">Everything you approve is recorded here.</EmptyState>
        )}
        {runsQuery.data && runsQuery.data.length > 0 && (
          <ul className="space-y-2">
            {runsQuery.data.map((r) => (
              <li key={r.id} className="rounded-md bg-slate-50 p-2">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium text-slate-800">{r.intent}</span>
                  <Pill tone={STATUS_TONE[r.status]}>
                    {r.status === 'proposed' ? 'awaiting your approval' : r.status}
                  </Pill>
                </p>
                <p className="text-xs text-slate-500">
                  {r.sentQuery ? (
                    <>
                      sent: <span className="font-medium">“{r.sentQuery}”</span>
                    </>
                  ) : (
                    'nothing was sent'
                  )}
                  <span className="text-slate-400">
                    {' '}
                    · {new Date(r.createdAt).toLocaleString()}
                  </span>
                </p>
                {r.status === 'proposed' && (
                  <p className="mt-1 flex gap-2">
                    <button
                      type="button"
                      className={btnPrimary}
                      onClick={() => {
                        resume(r);
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                    >
                      Review &amp; approve
                    </button>
                    <button
                      type="button"
                      className={btnSecondary}
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate(r.id)}
                    >
                      Cancel
                    </button>
                  </p>
                )}
                {r.status === 'approved' && r.answer && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-brand-teal-ink dark:text-brand-teal">
                      View answer
                    </summary>
                    <p className="mt-1 whitespace-pre-wrap rounded border border-slate-200 p-2 text-xs text-slate-700">
                      {r.answer}
                    </p>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Shell>
  );
}
