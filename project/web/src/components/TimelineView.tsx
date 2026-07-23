import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  LaterFate,
  MemoryListItem,
  PointInTimeFact,
  TimelineChange,
  TimelineSpan,
} from '@cogeto/shared';
import { fetchTimeline, fetchTimelineAt, fetchTimelineDiff } from '../api';
import type { Session } from '../auth/oidc';
import { PAST_CHIP } from './status';
import { EmptyState, ErrorState, SectionTitle, SkeletonRows, StatusChip, Tabs } from './ui';

type Mode = 'timeline' | 'at' | 'compare';

/** A whole-day ISO instant (UTC midnight) for the date inputs. */
const toInstant = (day: string): string => new Date(`${day}T00:00:00.000Z`).toISOString();
const toDay = (iso: string): string => iso.slice(0, 10);
const humanDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** Source kind → a natural phrase for the "what changed it" reading. */
function sourceLabel(sourceType: string): string {
  switch (sourceType) {
    case 'user_note':
      return 'a note';
    case 'chat':
      return 'a chat message';
    case 'email':
      return 'an email';
    case 'file_upload':
      return 'a document';
    default:
      return `a ${sourceType.replace('_', ' ')}`;
  }
}

const FATE_LABEL: Record<LaterFate, string> = {
  still_current: 'still current',
  replaced: 'later replaced',
  outdated: 'later marked outdated',
  expired: 'later expired',
};

/**
 * The time-travel surface (decision 0012) — one subject's honest, inspectable
 * past. Three readings over the same gated primitives: the full history as
 * spans, the subject as understood at a chosen instant, and the diff between two
 * instants phrased in the F3 past-belief framing. No new visual vocabulary: the
 * O3 status chips, the muted "past" variant, and source-opening drawers.
 */
export function TimelineView({
  session,
  subject,
  initialMode = 'timeline',
  initialAt,
  initialFrom,
  initialTo,
  onOpenMemory,
}: {
  session: Session;
  subject: string;
  initialMode?: Mode;
  initialAt?: string;
  initialFrom?: string;
  initialTo?: string;
  /** Open the governance drawer (with the source) for a memory. */
  onOpenMemory: (memoryId: string) => void;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const today = new Date().toISOString().slice(0, 10);
  const [at, setAt] = useState(initialAt ? toDay(initialAt) : today);
  const [from, setFrom] = useState(initialFrom ? toDay(initialFrom) : '');
  const [to, setTo] = useState(initialTo ? toDay(initialTo) : today);

  return (
    <div className="space-y-4">
      <Tabs<Mode>
        active={mode}
        onChange={setMode}
        tabs={[
          { key: 'timeline', label: 'Timeline' },
          { key: 'at', label: 'At a date' },
          { key: 'compare', label: 'Compare two dates' },
        ]}
      />
      {mode === 'timeline' && (
        <TimelinePanel session={session} subject={subject} onOpenMemory={onOpenMemory} />
      )}
      {mode === 'at' && (
        <PointInTimePanel
          session={session}
          subject={subject}
          day={at}
          onDay={setAt}
          onOpenMemory={onOpenMemory}
        />
      )}
      {mode === 'compare' && (
        <ComparePanel
          session={session}
          subject={subject}
          from={from}
          to={to}
          onFrom={setFrom}
          onTo={setTo}
          onOpenMemory={onOpenMemory}
        />
      )}
    </div>
  );
}

// ── Timeline: each fact's life as a span ─────────────────────────────────────
function TimelinePanel({
  session,
  subject,
  onOpenMemory,
}: {
  session: Session;
  subject: string;
  onOpenMemory: (id: string) => void;
}) {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['timeline', subject],
    queryFn: () => fetchTimeline(session, subject),
  });
  if (isPending) return <SkeletonRows rows={4} label="Loading the timeline…" />;
  if (isError)
    return <ErrorState onRetry={() => void refetch()}>Couldn’t load this timeline.</ErrorState>;
  if (data.spans.length === 0)
    return (
      <EmptyState icon="🕰" title={`Nothing on record about ${subject}.`}>
        When you capture facts that mention {subject}, their history appears here.
      </EmptyState>
    );

  return (
    <ol className="relative space-y-3 border-l border-slate-200 pl-5">
      {data.spans.map((span) => (
        <SpanRow key={span.memory.id} span={span} onOpenMemory={onOpenMemory} />
      ))}
    </ol>
  );
}

function SpanRow({
  span,
  onOpenMemory,
}: {
  span: TimelineSpan;
  onOpenMemory: (id: string) => void;
}) {
  const period = span.effectiveUntil
    ? `${humanDate(span.effectiveFrom)} → ${humanDate(span.effectiveUntil)}`
    : `since ${humanDate(span.effectiveFrom)}`;
  return (
    <li className="relative">
      {/* Rail marker: teal for a currently-held fact, muted for a past one. */}
      <span
        aria-hidden="true"
        className={`absolute -left-[27px] top-1.5 h-3 w-3 rounded-full border-2 border-surface ${
          span.current ? 'bg-brand-teal' : 'bg-slate-300'
        }`}
      />
      <div
        className={`rounded-lg border p-3 ${
          span.current
            ? 'border-brand-teal/40 bg-brand-teal-surface/30 dark:bg-brand-teal/10'
            : 'border-slate-200 bg-surface'
        }`}
      >
        <button
          type="button"
          onClick={() => onOpenMemory(span.memory.id)}
          className="block w-full text-left text-sm text-slate-800 hover:underline"
          title="Open this fact: its verification, provenance and source"
        >
          {span.memory.content}
        </button>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <StatusChip status={span.memory.status} />
          {span.current && (
            <span className="rounded-full bg-brand-teal-surface dark:bg-brand-teal/15 px-2 py-0.5 font-semibold text-brand-teal-ink dark:text-brand-teal">
              current
            </span>
          )}
          {span.pastBelief && (
            <span className={`rounded-full px-2 py-0.5 font-semibold ${PAST_CHIP}`}>past</span>
          )}
          <span className="text-slate-400">{period}</span>
          {span.supersededBy && (
            <button
              type="button"
              onClick={() => onOpenMemory(span.supersededBy!)}
              className="text-brand-teal-ink dark:text-brand-teal hover:underline"
            >
              → what replaced it
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

// ── Point-in-time: the subject as understood at an instant ───────────────────
function PointInTimePanel({
  session,
  subject,
  day,
  onDay,
  onOpenMemory,
}: {
  session: Session;
  subject: string;
  day: string;
  onDay: (day: string) => void;
  onOpenMemory: (id: string) => void;
}) {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['timeline-at', subject, day],
    queryFn: () => fetchTimelineAt(session, subject, toInstant(day)),
    enabled: Boolean(day),
  });
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm text-slate-600">
        Move to a date
        <input
          type="date"
          value={day}
          max={new Date().toISOString().slice(0, 10)}
          onChange={(e) => onDay(e.target.value)}
          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
        />
      </label>
      <p className="text-xs text-slate-400">
        What Cogeto understood about {subject} on {humanDate(toInstant(day))}, including facts since
        replaced, each labelled with what happened to it later.
      </p>
      {isPending && <SkeletonRows rows={3} label="Reconstructing that moment…" />}
      {isError && (
        <ErrorState onRetry={() => void refetch()}>Couldn’t reconstruct that moment.</ErrorState>
      )}
      {data && data.facts.length === 0 && (
        <EmptyState icon="◦" title={`Nothing was on record about ${subject} then.`} />
      )}
      {data && data.facts.length > 0 && (
        <ul className="space-y-2">
          {data.facts.map((fact) => (
            <PitFactRow key={fact.memory.id} fact={fact} onOpenMemory={onOpenMemory} />
          ))}
        </ul>
      )}
    </div>
  );
}

function PitFactRow({
  fact,
  onOpenMemory,
}: {
  fact: PointInTimeFact;
  onOpenMemory: (id: string) => void;
}) {
  const past = fact.laterFate !== 'still_current';
  return (
    <li
      className={`rounded-lg border p-3 ${
        past
          ? 'border-slate-200 bg-surface'
          : 'border-brand-teal/40 bg-brand-teal-surface/30 dark:bg-brand-teal/10'
      }`}
    >
      <button
        type="button"
        onClick={() => onOpenMemory(fact.memory.id)}
        className="block w-full text-left text-sm text-slate-800 hover:underline"
      >
        {fact.memory.content}
      </button>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <StatusChip status={fact.memory.status} />
        <span
          className={`rounded-full px-2 py-0.5 font-semibold ${past ? PAST_CHIP : 'bg-brand-teal-surface dark:bg-brand-teal/15 text-brand-teal-ink dark:text-brand-teal'}`}
        >
          {FATE_LABEL[fact.laterFate]}
        </span>
        {fact.supersededBy && (
          <button
            type="button"
            onClick={() => onOpenMemory(fact.supersededBy!)}
            className="text-brand-teal-ink dark:text-brand-teal hover:underline"
          >
            → what replaced it
          </button>
        )}
      </div>
    </li>
  );
}

// ── Compare: the diff between two instants ───────────────────────────────────
function ComparePanel({
  session,
  subject,
  from,
  to,
  onFrom,
  onTo,
  onOpenMemory,
}: {
  session: Session;
  subject: string;
  from: string;
  to: string;
  onFrom: (day: string) => void;
  onTo: (day: string) => void;
  onOpenMemory: (id: string) => void;
}) {
  const ready = Boolean(from && to && from <= to);
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['timeline-diff', subject, from, to],
    queryFn: () => fetchTimelineDiff(session, subject, toInstant(from), toInstant(to)),
    enabled: ready,
  });
  const nothing = data && data.added.length + data.changed.length + data.removed.length === 0;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3 text-sm text-slate-600">
        <label className="flex flex-col gap-1">
          From
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => onFrom(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1">
          To
          <input
            type="date"
            value={to}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => onTo(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1"
          />
        </label>
      </div>
      {!ready && (
        <p className="text-xs text-slate-400">Pick two dates to see what changed between them.</p>
      )}
      {ready && isPending && <SkeletonRows rows={3} label="Comparing…" />}
      {ready && isError && (
        <ErrorState onRetry={() => void refetch()}>Couldn’t compare those dates.</ErrorState>
      )}
      {data && nothing && (
        <EmptyState
          icon="＝"
          tone="positive"
          title={`Nothing changed about ${subject} between ${humanDate(toInstant(from))} and ${humanDate(toInstant(to))}.`}
        >
          {data.unchanged.length > 0
            ? 'Everything on record then still held.'
            : 'There was nothing on record in that window.'}
        </EmptyState>
      )}
      {data && !nothing && (
        <div className="space-y-4">
          {data.changed.length > 0 && (
            <section className="space-y-2">
              <SectionTitle as="h3">What changed</SectionTitle>
              {data.changed.map((change) => (
                <ChangeRow
                  key={change.before.id}
                  subject={subject}
                  change={change}
                  fromDay={from}
                  toDay={to}
                  onOpenMemory={onOpenMemory}
                />
              ))}
            </section>
          )}
          {data.added.length > 0 && (
            <DiffList
              title="What you learned"
              items={data.added}
              tone="add"
              onOpenMemory={onOpenMemory}
            />
          )}
          {data.removed.length > 0 && (
            <DiffList
              title="What became outdated"
              items={data.removed}
              tone="remove"
              onOpenMemory={onOpenMemory}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ChangeRow({
  subject,
  change,
  fromDay,
  toDay,
  onOpenMemory,
}: {
  subject: string;
  change: TimelineChange;
  fromDay: string;
  toDay: string;
  onOpenMemory: (id: string) => void;
}) {
  // "Explain this change" hands off to chat with the question ready (never auto-sent).
  const question = `What changed about ${subject}, and what caused it, between ${humanDate(toInstant(fromDay))} and ${humanDate(toInstant(toDay))}?`;
  // Past-belief framing, same story the chat answer tells (decision 0012 ruling 6).
  return (
    <div className="rounded-lg border border-slate-200 bg-surface p-3 text-sm">
      <p className="text-slate-700">
        <span className="text-slate-400">In {humanDate(toInstant(fromDay))}, </span>
        <button
          type="button"
          onClick={() => onOpenMemory(change.before.id)}
          className={`rounded px-1 ${PAST_CHIP} hover:underline`}
        >
          “{change.before.content}”
        </button>
      </p>
      <p className="mt-1 text-slate-700">
        <span className="text-slate-400">
          By {humanDate(toInstant(toDay))}, {sourceLabel(change.after.sourceType)} changed it
          to{' '}
        </span>
        <button
          type="button"
          onClick={() => onOpenMemory(change.after.id)}
          className="rounded bg-brand-teal-surface dark:bg-brand-teal/15 px-1 font-medium text-brand-teal-ink dark:text-brand-teal hover:underline"
        >
          “{change.after.content}”
        </button>
      </p>
      <a
        href={`/chat?q=${encodeURIComponent(question)}`}
        className="mt-2 inline-block text-xs text-brand-teal-ink dark:text-brand-teal hover:underline"
      >
        Explain this change in chat →
      </a>
    </div>
  );
}

function DiffList({
  title,
  items,
  tone,
  onOpenMemory,
}: {
  title: string;
  items: MemoryListItem[];
  tone: 'add' | 'remove';
  onOpenMemory: (id: string) => void;
}) {
  return (
    <section className="space-y-2">
      <SectionTitle as="h3">{title}</SectionTitle>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onOpenMemory(item.id)}
              className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm hover:bg-slate-50 ${
                tone === 'add' ? 'border-brand-teal/30' : 'border-slate-200'
              }`}
            >
              <span
                aria-hidden="true"
                className={
                  tone === 'add' ? 'text-brand-teal-ink dark:text-brand-teal' : 'text-slate-400'
                }
              >
                {tone === 'add' ? '+' : '−'}
              </span>
              <span className="text-slate-700">{item.content}</span>
              <span className="ml-auto">
                <StatusChip status={item.status} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
