import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { WorkerActivityDto, WorkerJobDto } from '@cogeto/shared';
import { fetchWorkerActivity } from '../api';
import type { Session } from '../auth/oidc';
import { i18next } from '../i18n';
import { formatNumber } from '../i18n/format';
import { timeAgo } from './status';

/**
 * The queue's job TYPES are the worker's own vocabulary and travel as values;
 * only their display names are translated, through `system:job.<type>`. An
 * unknown type renders verbatim rather than as a raw key, exactly as before.
 */
const JOB_TYPE_KEYS: Record<string, string> = {
  'ingestion.pipeline': 'ingestionPipeline',
  'deletion.execute': 'deletionExecute',
  'memory.embed': 'memoryEmbed',
  deletion_sweep: 'deletionSweep',
  dreaming_cycle: 'dreamingCycle',
  echo: 'echo',
};
const jobLabel = (type: string): string => {
  const key = JOB_TYPE_KEYS[type];
  return key ? i18next.t(`system:job.${key}`) : type;
};

function sourceLabel(sourceType: string | null, sourceId: string | null): string | null {
  if (!sourceType) return null;
  const kind =
    sourceType === 'user_note'
      ? i18next.t('sources:kind.note')
      : sourceType === 'file'
        ? i18next.t('sources:kind.file')
        : sourceType.replace(/_/g, ' ');
  // File source ids are object keys; show only the final `file-…` segment.
  const tail = sourceId ? (sourceId.split('/').pop() ?? sourceId).slice(0, 16) : null;
  return tail ? i18next.t('system:worker.sourceWithId', { kind, id: tail }) : kind;
}

function elapsedSince(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return i18next.t('system:worker.elapsedSeconds', { seconds: s });
  return i18next.t('system:worker.elapsedMinutes', {
    minutes: Math.floor(s / 60),
    seconds: s % 60,
  });
}

/** A count chip. `label` arrives already translated from the call site. */
function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'active' | 'muted' | 'alert';
}) {
  const cls =
    tone === 'active'
      ? 'bg-brand-teal-surface dark:bg-brand-teal/15 text-brand-teal-ink dark:text-brand-teal'
      : tone === 'alert'
        ? 'bg-red-100 dark:bg-red-500/15 text-red-700 dark:text-red-300'
        : 'bg-slate-100 text-slate-600';
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>
      {value} {label}
    </span>
  );
}

/** One running job: friendly label, source, elapsed, and an indeterminate bar. */
function RunningRow({ job, now }: { job: WorkerJobDto; now: number }) {
  const { t } = useTranslation('system');
  const source = sourceLabel(job.sourceType, job.sourceId);
  return (
    <li className="rounded-md border border-slate-200 p-2.5">
      <div className="flex items-center gap-2 text-sm">
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-brand-teal" />
        <span className="font-medium text-slate-700">{jobLabel(job.jobType)}</span>
        {source && <span className="truncate text-xs text-slate-400">{source}</span>}
        <span className="ml-auto shrink-0 text-xs tabular-nums text-slate-400">
          {job.since
            ? t('worker.runningFor', { elapsed: elapsedSince(job.since, now) })
            : t('worker.running')}
          {job.attempts > 1 ? t('worker.attemptSuffix', { count: job.attempts }) : ''}
        </span>
      </div>
      {/* Indeterminate: jobs are atomic, so this signals "working", not a fill %. */}
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full w-1/3 animate-worker-indeterminate rounded-full bg-brand-teal/70" />
      </div>
    </li>
  );
}

function QueuedRow({ job, now }: { job: WorkerJobDto; now: number }) {
  const { t } = useTranslation('system');
  const source = sourceLabel(job.sourceType, job.sourceId);
  const retrying = job.attempts > 0 && Boolean(job.lastError);
  return (
    <li className="flex items-center gap-2 py-1 text-sm text-slate-500">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
      <span className="text-slate-600">{jobLabel(job.jobType)}</span>
      {source && <span className="truncate text-xs text-slate-400">{source}</span>}
      <span className="ml-auto shrink-0 text-xs text-slate-400">
        {retrying ? (
          <span className="text-amber-600" title={job.lastError ?? undefined}>
            {job.runAt
              ? t('worker.retryingAt', { when: timeAgo(job.runAt) })
              : t('worker.retrying')}
          </span>
        ) : job.runAt && new Date(job.runAt).getTime() > now ? (
          t('worker.scheduled', { when: timeAgo(job.runAt) })
        ) : (
          t('worker.queued')
        )}
      </span>
    </li>
  );
}

/**
 * The System page's live worker view (O1): what the background worker is doing
 * right now, how deep the queue is (the honest progress signal — it drains
 * visibly), and what recently completed. Polls fast while busy, slowly when idle.
 */
export function WorkerActivityPanel({ session }: { session: Session }) {
  const { t } = useTranslation('system');
  const { data, isPending, isError } = useQuery({
    queryKey: ['worker-activity'],
    queryFn: () => fetchWorkerActivity(session),
    refetchInterval: (query) => {
      const s = (query.state.data as WorkerActivityDto | undefined)?.summary;
      return s && (s.running > 0 || s.queued > 0) ? 2000 : 6000;
    },
  });

  // A 1s ticker so the "running Ns" timers advance smoothly between polls.
  const [now, setNow] = useState(() => Date.now());
  const busy = Boolean(data && (data.summary.running > 0 || data.summary.queued > 0));
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [busy]);

  const idle =
    data && data.summary.running === 0 && data.summary.queued === 0 && data.summary.waiting === 0;

  return (
    <section className="rounded-lg border border-slate-200 bg-surface p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t('worker.heading')}
        </h2>
        <span
          className={`h-2 w-2 rounded-full ${busy ? 'animate-pulse bg-brand-teal' : 'bg-slate-300'}`}
          title={busy ? t('worker.processing') : t('worker.idle')}
          role="img"
          aria-label={busy ? t('worker.processing') : t('worker.idle')}
        />
      </div>

      {isPending && <p className="text-sm text-slate-400">{t('common:state.loading')}</p>}
      {isError && (
        <p className="text-sm text-red-700 dark:text-red-300" role="alert">
          {t('worker.error')}
        </p>
      )}

      {data && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {idle ? (
              <span className="rounded-full bg-brand-teal-surface dark:bg-brand-teal/15 px-2 py-0.5 text-xs font-semibold text-brand-teal-ink dark:text-brand-teal">
                {t('worker.allProcessed')}
              </span>
            ) : (
              <>
                {data.summary.running > 0 && (
                  <Stat
                    label={t('worker.stat.running')}
                    value={data.summary.running}
                    tone="active"
                  />
                )}
                {data.summary.queued > 0 && (
                  <Stat label={t('worker.stat.queued')} value={data.summary.queued} tone="active" />
                )}
                {data.summary.waiting > 0 && (
                  <Stat
                    label={t('worker.stat.waiting')}
                    value={data.summary.waiting}
                    tone="muted"
                  />
                )}
              </>
            )}
            {data.summary.deadLetter > 0 && (
              <Stat label={t('worker.stat.failed')} value={data.summary.deadLetter} tone="alert" />
            )}
            <span className="ml-auto text-xs text-slate-400">
              {t('worker.completedAllTime', {
                count: data.summary.completedTotal,
                value: formatNumber(data.summary.completedTotal),
              })}
            </span>
          </div>

          {data.running.length > 0 && (
            <ul className="space-y-2">
              {data.running.map((job, i) => (
                <RunningRow key={`${job.jobType}-${job.sourceId ?? i}`} job={job} now={now} />
              ))}
            </ul>
          )}

          {(data.queued.length > 0 || data.waiting.length > 0) && (
            <div className="mt-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                {t('worker.upNext')}
              </p>
              <ul className="divide-y divide-slate-100">
                {[...data.queued, ...data.waiting].slice(0, 6).map((job, i) => (
                  <QueuedRow key={`${job.jobType}-${job.sourceId ?? i}`} job={job} now={now} />
                ))}
              </ul>
              {data.queued.length + data.waiting.length > 6 && (
                <p className="mt-1 text-xs text-slate-400">
                  {t('worker.moreWaiting', {
                    count: data.queued.length + data.waiting.length - 6,
                  })}
                </p>
              )}
            </div>
          )}

          {data.recent.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                {t('worker.recentlyCompleted')}
              </p>
              <ul className="space-y-1">
                {data.recent.map((c, i) => (
                  <li
                    key={`${c.jobType}-${c.sourceId ?? i}`}
                    className="flex items-center gap-2 text-xs text-slate-500"
                  >
                    <span className="text-brand-teal-ink dark:text-brand-teal">✓</span>
                    <span className="text-slate-600">{jobLabel(c.jobType)}</span>
                    {sourceLabel(c.sourceType, c.sourceId) && (
                      <span className="truncate text-slate-400">
                        {sourceLabel(c.sourceType, c.sourceId)}
                      </span>
                    )}
                    <span className="ml-auto shrink-0 text-slate-400" title={c.at}>
                      {timeAgo(c.at)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
