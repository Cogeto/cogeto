import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SkillRunDetailDto, SkillRunDto, SkillRunStepDto } from '@cogeto/shared';
import {
  approveSkillPlan,
  cancelSkillRun,
  fetchSkillRun,
  fetchSkillRuns,
  proposeSkillRun,
} from '../api';
import type { Session } from '../auth/oidc';
import { BriefAnswer } from '../components/BriefAnswer';
import { Shell } from '../components/Shell';
import { briefExportText, gateOpen, runIsLive, runStatusLine } from '../components/skills-model';
import type { Tone } from '../components/status';
import { timeAgo, TONE_CLASS } from '../components/status';
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

const STATUS_TONE: Record<SkillRunDto['status'], Tone> = {
  planning: 'info',
  awaiting_approval: 'warning',
  running: 'info',
  awaiting_input: 'warning',
  completed: 'positive',
  failed: 'danger',
  cancelled: 'neutral',
};

const STATUS_LABEL: Record<SkillRunDto['status'], string> = {
  planning: 'planning',
  awaiting_approval: 'awaiting approval',
  running: 'running',
  awaiting_input: 'awaiting input',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

const runLink = (id: string) => `/skills?run=${encodeURIComponent(id)}`;

/**
 * The skill surface. One skill in v1: research a
 * company or person before a meeting. The run view IS the claim: every step
 * inspectable as it happens, the query plan approved before anything leaves,
 * every brief claim clickable to its source, and proposed actions that wait.
 */
export function Skills({ session }: { session: Session }) {
  const openRunId = new URLSearchParams(window.location.search).get('run');
  return (
    <Shell session={session} title="Skills" active="skills">
      {openRunId ? (
        <SkillRunView session={session} runId={openRunId} />
      ) : (
        <SkillsHome session={session} />
      )}
    </Shell>
  );
}

function SkillsHome({ session }: { session: Session }) {
  const [subject, setSubject] = useState('');
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runsQuery = useQuery({
    queryKey: ['skill-runs'],
    queryFn: () => fetchSkillRuns(session),
  });
  const propose = useMutation({
    mutationFn: (value: string) => proposeSkillRun(session, 'research_brief', value),
    onSuccess: (outcome) => {
      if (outcome.status === 'ambiguous') {
        setCandidates(outcome.candidates);
        return;
      }
      window.location.assign(runLink(outcome.run.id));
    },
    onError: (e: Error) => setError(e.message),
  });

  const start = (event: FormEvent) => {
    event.preventDefault();
    const value = subject.trim();
    if (!value || propose.isPending) return;
    setError(null);
    setCandidates(null);
    propose.mutate(value);
  };

  return (
    <div className="space-y-6">
      <Card>
        <SectionTitle>Research a company or person before a meeting</SectionTitle>
        <p className="mt-1 text-sm text-slate-600">
          Cogeto checks what you already know, proposes minimised searches for your approval, reads
          the approved pages, and writes a brief where every claim links to its source. Nothing
          leaves this instance until you approve the search plan.
        </p>
        <form onSubmit={start} className="mt-3 flex gap-2">
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="A company or person, e.g. Adriatic Foods"
            aria-label="Subject to research"
            className="min-w-0 flex-1 rounded-md border border-slate-300 bg-surface px-3 py-2 text-sm"
            maxLength={200}
          />
          <button
            type="submit"
            className={btnPrimary}
            disabled={propose.isPending || !subject.trim()}
          >
            {propose.isPending ? 'Planning…' : 'Prepare a brief'}
          </button>
        </form>
        {candidates && (
          <div className="mt-3 rounded-md border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            <p className="font-medium">Which one do you mean?</p>
            <ul className="mt-1 space-y-1">
              {candidates.map((candidate) => (
                <li key={candidate}>
                  <button
                    type="button"
                    className="underline decoration-dotted underline-offset-2 hover:text-amber-900"
                    onClick={() => {
                      setSubject(candidate);
                      setCandidates(null);
                      propose.mutate(candidate);
                    }}
                  >
                    {candidate}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && <p className="mt-2 text-sm text-red-600 dark:text-red-300">{error}</p>}
      </Card>

      <Card>
        <SectionTitle>Runs</SectionTitle>
        {runsQuery.isPending ? (
          <SkeletonRows rows={3} />
        ) : runsQuery.isError ? (
          <ErrorState onRetry={() => void runsQuery.refetch()}>
            Could not load skill runs.
          </ErrorState>
        ) : runsQuery.data.length === 0 ? (
          <EmptyState title="No runs yet">
            Try &quot;Prepare a brief&quot; above, or ask in chat: &quot;research Adriatic Foods
            before Thursday&quot;.
          </EmptyState>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100">
            {runsQuery.data.map((run) => (
              <li key={run.id}>
                <a
                  href={runLink(run.id)}
                  className="flex items-center gap-3 py-2.5 transition-colors hover:bg-slate-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-800">
                      {run.subject}
                    </span>
                    <span className="block truncate text-xs text-slate-500">
                      {run.skillName} · {timeAgo(run.createdAt)}
                    </span>
                  </span>
                  <Pill tone={STATUS_TONE[run.status]}>{STATUS_LABEL[run.status]}</Pill>
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** The live run view — the step log is the inspectability showcase. */
function SkillRunView({ session, runId }: { session: Session; runId: string }) {
  const queryClient = useQueryClient();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const runQuery = useQuery({
    queryKey: ['skill-run', runId],
    queryFn: () => fetchSkillRun(session, runId),
    refetchInterval: (query) =>
      query.state.data && runIsLive(query.state.data.status) ? 2500 : false,
  });

  const refresh = (detail: SkillRunDetailDto) => {
    queryClient.setQueryData(['skill-run', runId], detail);
    void queryClient.invalidateQueries({ queryKey: ['skill-runs'] });
  };
  const approve = useMutation({
    mutationFn: (queries: { researchRunId: string; query: string }[]) =>
      approveSkillPlan(session, runId, queries),
    onSuccess: refresh,
    onError: (e: Error) => setError(e.message),
  });
  const cancel = useMutation({
    mutationFn: () => cancelSkillRun(session, runId),
    onSuccess: refresh,
    onError: (e: Error) => setError(e.message),
  });
  if (runQuery.isPending) {
    return (
      <Card>
        <SkeletonRows rows={6} />
      </Card>
    );
  }
  if (runQuery.isError) {
    return (
      <ErrorState onRetry={() => void runQuery.refetch()}>Could not load this run.</ErrorState>
    );
  }
  const run = runQuery.data;
  const openPlan = run.plan.filter((q) => q.status === 'proposed');
  const keptCount = openPlan.filter((q) => !removed.has(q.researchRunId)).length;

  const submitPlan = () => {
    const queries = openPlan
      .filter((q) => !removed.has(q.researchRunId))
      .map((q) => ({
        researchRunId: q.researchRunId,
        query: (edits[q.researchRunId] ?? q.minimisedQuery).trim() || q.minimisedQuery,
      }));
    if (queries.length === 0) return;
    setError(null);
    approve.mutate(queries);
  };

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <a href="/skills" className="text-sm text-slate-500 hover:underline">
            ← Skills
          </a>
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-slate-900">
            {run.subject}
          </h2>
          <Pill tone={STATUS_TONE[run.status]}>{STATUS_LABEL[run.status]}</Pill>
          {(run.status === 'awaiting_approval' || runIsLive(run.status)) && (
            <button type="button" className={btnDanger} onClick={() => cancel.mutate()}>
              Cancel run
            </button>
          )}
        </div>
        <p className="mt-1 text-sm text-slate-600" role="status" aria-live="polite">
          {runStatusLine(run, run.steps)}
        </p>
        {error && <p className="mt-2 text-sm text-red-600 dark:text-red-300">{error}</p>}
      </Card>

      <Card>
        <SectionTitle>Steps</SectionTitle>
        <ol className="mt-3 space-y-0">
          {run.steps.map((step, i) => (
            <StepRow key={step.id} step={step} last={i === run.steps.length - 1} />
          ))}
        </ol>
      </Card>

      {gateOpen(run) && openPlan.length > 0 && (
        <Card>
          <SectionTitle>The search plan: approve before anything leaves</SectionTitle>
          <p className="mt-1 text-sm text-slate-600">
            These queries were proposed from your context, minimised. Edit any, remove any; nothing
            is sent until you approve. Each approved query is recorded in the provenance of every
            fact it produces.
          </p>
          <ul className="mt-3 space-y-3">
            {openPlan.map((query) => {
              const isRemoved = removed.has(query.researchRunId);
              return (
                <li
                  key={query.researchRunId}
                  className={`rounded-lg border p-3 ${isRemoved ? 'border-slate-200 opacity-50' : 'border-slate-200'}`}
                >
                  <div className="flex items-start gap-2">
                    <input
                      value={edits[query.researchRunId] ?? query.minimisedQuery}
                      onChange={(e) =>
                        setEdits((prev) => ({ ...prev, [query.researchRunId]: e.target.value }))
                      }
                      disabled={isRemoved}
                      aria-label="Search query"
                      className="min-w-0 flex-1 rounded-md border border-slate-300 bg-surface px-3 py-1.5 text-sm"
                      maxLength={500}
                    />
                    <button
                      type="button"
                      className={btnSecondary}
                      onClick={() =>
                        setRemoved((prev) => {
                          const next = new Set(prev);
                          if (next.has(query.researchRunId)) next.delete(query.researchRunId);
                          else next.add(query.researchRunId);
                          return next;
                        })
                      }
                    >
                      {isRemoved ? 'Keep' : 'Remove'}
                    </button>
                  </div>
                  <p className="mt-1.5 text-xs text-slate-500">{query.minimiseReason}</p>
                </li>
              );
            })}
          </ul>
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              className={btnPrimary}
              disabled={keptCount === 0 || approve.isPending}
              onClick={submitPlan}
            >
              {approve.isPending
                ? 'Approving…'
                : `Approve ${keptCount} ${keptCount === 1 ? 'search' : 'searches'}`}
            </button>
            <span className="text-xs text-slate-500">
              Removed queries are cancelled and never leave.
            </span>
          </div>
        </Card>
      )}

      {run.plan.length > 0 && !gateOpen(run) && (
        <Card>
          <SectionTitle>What was searched</SectionTitle>
          <ul className="mt-2 space-y-1.5">
            {run.plan.map((query) => (
              <li key={query.researchRunId} className="flex items-baseline gap-2 text-sm">
                {query.status === 'cancelled' ? (
                  <>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${TONE_CLASS.neutral}`}>
                      removed
                    </span>
                    <span className="text-slate-400 line-through">{query.minimisedQuery}</span>
                  </>
                ) : (
                  <>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${TONE_CLASS.positive}`}>
                      sent
                    </span>
                    <span className="font-mono text-slate-700">{query.sentQuery}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {run.brief && (
        <Card>
          <div className="flex items-center gap-3">
            <SectionTitle>The brief</SectionTitle>
            <span className="flex-1" />
            <button
              type="button"
              className={btnSecondary}
              onClick={() => {
                void navigator.clipboard.writeText(briefExportText(run));
              }}
            >
              Copy with sources
            </button>
          </div>
          <div className="mt-3">
            <BriefAnswer brief={run.brief} citations={run.briefCitations} />
          </div>
        </Card>
      )}
    </div>
  );
}

/** One step of the log: state, phrasing, and its artifacts one click away. */
function StepRow({ step, last }: { step: SkillRunStepDto; last: boolean }) {
  const state = STEP_STATE[step.status];
  return (
    <li className="relative flex gap-3 pb-4">
      {!last && (
        <span aria-hidden="true" className="absolute left-[9px] top-6 h-full w-px bg-slate-200" />
      )}
      <span
        aria-hidden="true"
        className={`relative z-10 mt-0.5 grid h-[19px] w-[19px] shrink-0 place-items-center rounded-full border text-[11px] ${state.dot}`}
      >
        {step.status === 'running' ? (
          <span className="h-2 w-2 animate-pulse rounded-full bg-current" />
        ) : (
          state.icon
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-medium ${state.title}`}>
          {step.title}
          <span className="sr-only"> ({step.status})</span>
        </p>
        {step.outputsSummary && (
          <p className="mt-0.5 text-sm text-slate-600">{step.outputsSummary}</p>
        )}
        {step.error && step.status === 'failed' && (
          <p className="mt-0.5 text-sm text-red-600 dark:text-red-300">{step.error}</p>
        )}
        <StepArtifacts step={step} />
      </div>
    </li>
  );
}

const STEP_STATE: Record<SkillRunStepDto['status'], { icon: string; dot: string; title: string }> =
  {
    pending: { icon: '·', dot: 'border-slate-300 text-slate-400', title: 'text-slate-400' },
    running: {
      icon: '',
      dot: 'border-brand-teal text-brand-teal',
      title: 'text-slate-900',
    },
    completed: {
      icon: '✓',
      dot: 'border-brand-teal bg-brand-teal/10 text-brand-teal-ink dark:text-brand-teal',
      title: 'text-slate-800',
    },
    failed: { icon: '!', dot: 'border-red-400 text-red-500', title: 'text-slate-800' },
    skipped: { icon: '-', dot: 'border-slate-300 text-slate-400', title: 'text-slate-500' },
  };

/** The links a step recorded — every produced artifact one click away. */
function StepArtifacts({ step }: { step: SkillRunStepDto }) {
  const memoryIds = [...(step.links.memoryIds ?? []), ...(step.links.loopMemoryIds ?? [])];
  if (memoryIds.length === 0 && !step.links.notes?.length) return null;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
      {memoryIds.slice(0, 8).map((id) => (
        <a
          key={id}
          href={`/memories?open=${id}`}
          className="rounded bg-slate-100 px-1.5 py-0.5 font-mono hover:underline"
        >
          ◈ {id.slice(0, 8)}
        </a>
      ))}
      {memoryIds.length > 8 && <span>+{memoryIds.length - 8} more</span>}
      {step.links.notes?.map((note, i) => (
        <span key={i}>{note}</span>
      ))}
    </p>
  );
}
