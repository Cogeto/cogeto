import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ContradictionDto, MemoryListItem, ResolveContradictionRequest } from '@cogeto/shared';
import { fetchContradictions, fetchNote, fetchVerification, resolveContradiction } from '../api';
import type { Session } from '../auth/oidc';
import { invalidateAfterContradiction } from '../query-invalidation';
import { Shell } from '../components/Shell';
import { timeAgo } from '../components/status';
import { btnPrimary, btnSecondary, EmptyState, ErrorState, SkeletonRows } from '../components/ui';

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
  const { t } = useTranslation('review');
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
        {memory.kind
          ? t('side.capturedWithKind', {
              kind: t(`factKind.${memory.kind}`, { defaultValue: memory.kind.replace('_', ' ') }),
              when: timeAgo(memory.createdAt),
            })
          : t('side.captured', { when: timeAgo(memory.createdAt) })}
      </p>
      <div className="mt-2 rounded-md bg-slate-50 p-2 text-xs text-slate-600">
        {note.data ? (
          <SourceWithSpan source={note.data.content} span={verification.data?.sourceSpan ?? null} />
        ) : (
          <p className="text-slate-400">
            {memory.sourceType === 'user_note' ? t('side.loadingSource') : `(${memory.sourceType})`}
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
  const { t } = useTranslation('review');
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
      // Chat chips, lists, badges — the contradiction-affected queries.
      await invalidateAfterContradiction(queryClient);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });
  const busy = resolve.isPending;

  return (
    <li className="rounded-lg border border-red-200 bg-red-50/40 p-4 shadow-sm dark:border-red-500/30 dark:bg-red-500/10">
      <p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-red-700 dark:text-red-300">
        <span aria-hidden="true">⚠</span>
        {t('item.heading')}
      </p>
      <div className="relative grid gap-3 md:grid-cols-2">
        <ContradictionSide
          session={session}
          label={t('item.newerFact')}
          accent="newer"
          memory={contradiction.a}
        />
        <span
          className="pointer-events-none absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 rounded-full border border-red-200 dark:border-red-500/30 bg-surface px-2 py-0.5 text-[11px] font-bold uppercase text-red-600 dark:text-red-300 md:block"
          aria-hidden="true"
        >
          {t('item.versus')}
        </span>
        <ContradictionSide
          session={session}
          label={t('item.earlierFact')}
          accent="earlier"
          memory={contradiction.b}
        />
      </div>
      {contradiction.reason && (
        <p className="mt-2 text-xs text-slate-500">
          <span className="font-medium text-slate-600">{t('item.whyFlagged')}</span>{' '}
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
            {t('item.correctedNewer')}
            <textarea
              value={aText}
              onChange={(e) => setAText(e.target.value)}
              rows={2}
              className="mt-1 w-full resize-y rounded-md border border-slate-300 p-2 text-sm font-normal"
            />
          </label>
          <label className="block text-xs font-semibold text-slate-500">
            {t('item.correctedEarlier')}
            <textarea
              value={bText}
              onChange={(e) => setBText(e.target.value)}
              rows={2}
              className="mt-1 w-full resize-y rounded-md border border-slate-300 p-2 text-sm font-normal"
            />
          </label>
          <p className="text-xs text-slate-500">{t('item.correctionExplainer')}</p>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || !aText.trim() || !bText.trim()}
              className={btnPrimary}
            >
              {t('item.saveBoth')}
            </button>
            <button type="button" onClick={() => setCorrecting(false)} className={btnSecondary}>
              {t('common:action.cancel')}
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
            {t('item.newerIsRight')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => resolve.mutate({ action: 'confirm_b' })}
            className={btnPrimary}
          >
            {t('item.earlierIsRight')}
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
            {t('item.correctBoth')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => resolve.mutate({ action: 'dismiss' })}
            className={btnSecondary}
            title={t('item.notAConflictTitle')}
          >
            {t('item.notAConflict')}
          </button>
          <span className="ml-auto text-xs text-slate-400" title={contradiction.detectedAt}>
            {t('item.detected', { when: timeAgo(contradiction.detectedAt) })}
          </span>
        </div>
      )}
    </li>
  );
}

/**
 * Contradictions: the one surface where a human verdict is still wanted.
 *
 * There used to be a second queue here, of facts the verifier could not fully
 * support. It is gone (V2.0 item 3.3): those facts are now admitted as
 * `uncertain` with a named reason, demoted in retrieval, framed softly in
 * answers, and explained in the suppressed-fact log, with no human step
 * anywhere. Confirming one is still possible, from the fact's own drawer, where
 * the fact and its evidence are in front of you rather than in a work list.
 *
 * Contradictions stay, because they are the case where the corpus genuinely
 * disagrees with itself and only the owner can say which side is right. They are
 * surfaced, never queued as a chore: the same resolution actions, the same audit
 * trail, unchanged.
 */
export function Review({ session }: { session: Session }) {
  const { t } = useTranslation('review');
  const contradictions = useQuery({
    queryKey: ['contradictions'],
    queryFn: () => fetchContradictions(session),
  });

  return (
    <Shell session={session} title={t('navigation:section.review')} active="review">
      {contradictions.isPending && <SkeletonRows rows={2} label={t('loading')} />}
      {contradictions.isError && (
        <ErrorState onRetry={() => void contradictions.refetch()}>{t('error')}</ErrorState>
      )}
      {contradictions.data && contradictions.data.length === 0 && (
        <EmptyState icon="🤝" tone="positive" title={t('empty.title')}>
          {t('empty.body')}
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
    </Shell>
  );
}
