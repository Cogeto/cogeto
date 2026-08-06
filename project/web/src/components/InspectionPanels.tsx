import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { SourceFactDto, SourceRevisionDto } from '@cogeto/shared';
import {
  confirmSourceRevision,
  fetchSourceCatalog,
  fetchSourceInspection,
  linkSourceRevision,
  rejectSourceRevision,
} from '../api';
import type { Session } from '../auth/oidc';
import { LocatorChips } from './LocatorChips';
import { ErrorState, Pill, SkeletonRows, StatusChip } from './ui';
import { timeAgo } from './status';

/**
 * Level two of the Sources surface (V2.2 item 5.2): every fact with its
 * status, sub-reason and LOCATED span; the suppressed-fact log in the same
 * view as what was kept; the contradictions in context. Rendered inside the
 * source drawer under the per-type body, for every source type.
 */
export function InspectionPanels({
  session,
  sourceType,
  sourceId,
  onOpenMemory,
}: {
  session: Session;
  sourceType: string;
  sourceId: string;
  /** Opens the fact detail (level three); absent renders plain rows. */
  onOpenMemory?: (memoryId: string) => void;
}) {
  const { t } = useTranslation('sources');
  const inspection = useQuery({
    queryKey: ['source-inspection', sourceType, sourceId],
    queryFn: () => fetchSourceInspection(session, sourceType, sourceId),
  });
  if (inspection.isPending) return <SkeletonRows rows={3} label={t('detail.loading')} />;
  if (inspection.isError) return <ErrorState>{t('detail.error')}</ErrorState>;
  const data = inspection.data;

  return (
    <>
      {data.gateRefusal && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {t('detail.gateRefused', {
            reason: t(`extraction:refusalReason.${data.gateRefusal}`, {
              defaultValue: data.gateRefusal,
            }),
          })}
        </p>
      )}

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t('detail.facts', { count: data.facts.length })}
        </h3>
        {data.facts.length === 0 ? (
          <p className="text-xs text-slate-400">{t('detail.noFacts')}</p>
        ) : (
          <ul className="space-y-3">
            {data.facts.map((fact) => (
              <FactRow key={fact.memory.id} fact={fact} onOpenMemory={onOpenMemory} />
            ))}
          </ul>
        )}
      </section>

      {data.suppressed.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {t('detail.suppressed', { count: data.suppressed.length })}
          </h3>
          <p className="mb-2 text-xs text-slate-400">{t('detail.suppressedExplainer')}</p>
          <ul className="space-y-3">
            {data.suppressed.map((entry) => (
              <li key={entry.id} className="rounded-md border border-slate-200 p-2.5 text-sm">
                <p className="text-slate-700">{entry.factContent}</p>
                <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
                  {entry.memoryId === null
                    ? t('detail.withheld', {
                        reason: t(`memories:uncertaintyReason.${entry.reason}`),
                      })
                    : t('detail.demoted', {
                        reason: t(`memories:uncertaintyReason.${entry.reason}`),
                      })}
                </p>
                <p className="mt-1 text-xs italic text-slate-500">
                  {t('detail.span', { span: entry.sourceSpan })}
                </p>
                {entry.spanLocators && <LocatorChips locators={entry.spanLocators} />}
              </li>
            ))}
          </ul>
        </section>
      )}

      <RevisionsPanel
        session={session}
        sourceType={sourceType}
        sourceId={sourceId}
        revisions={data.revisions}
      />

      {data.contradictions.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {t('detail.contradictions', { count: data.contradictions.length })}
          </h3>
          <ul className="space-y-3">
            {data.contradictions.map((item) => (
              <li key={item.relationId} className="rounded-md border border-slate-200 p-2.5">
                <MemoryLine content={item.a.content} id={item.a.id} onOpen={onOpenMemory} />
                <p className="my-1 text-center font-mono text-[0.62rem] uppercase tracking-[0.1em] text-red-500">
                  {t('detail.versus')}
                </p>
                <MemoryLine content={item.b.content} id={item.b.id} onOpen={onOpenMemory} />
                <p className="mt-1.5 text-xs text-slate-400">
                  {item.resolvedAt
                    ? t('detail.contradictionResolved', {
                        when: timeAgo(item.detectedAt),
                        resolution: item.resolution ?? '',
                      })
                    : t('detail.contradictionOpen', { when: timeAgo(item.detectedAt) })}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/**
 * The revision links touching this source (V2.2 item 5.3): auto links stated
 * with their basis, proposals decided here, and a manual link for the case
 * the conservative detector declined. A rejected pair stays visible so its
 * never-re-proposed state is inspectable.
 */
function RevisionsPanel({
  session,
  sourceType,
  sourceId,
  revisions,
}: {
  session: Session;
  sourceType: string;
  sourceId: string;
  revisions: SourceRevisionDto[];
}) {
  const { t } = useTranslation('sources');
  const queryClient = useQueryClient();
  const [linking, setLinking] = useState(false);
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['source-inspection', sourceType, sourceId] });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'confirm' | 'reject' }) =>
      decision === 'confirm'
        ? confirmSourceRevision(session, id)
        : rejectSourceRevision(session, id),
    onSuccess: refresh,
  });

  if (revisions.length === 0 && sourceType !== 'file') return null;

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {t('revisions.heading')}
      </h3>
      {revisions.length === 0 && <p className="text-xs text-slate-400">{t('revisions.none')}</p>}
      <ul className="space-y-2">
        {revisions.map((revision) => {
          const isSuccessor = revision.successorId === sourceId;
          const otherType = isSuccessor ? revision.predecessorType : revision.successorType;
          const otherId = isSuccessor ? revision.predecessorId : revision.successorId;
          const basis = revision.basis;
          return (
            <li key={revision.id} className="rounded-md border border-slate-200 p-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-slate-700">
                  {isSuccessor ? t('revisions.supersedes') : t('revisions.supersededBy')}
                </span>
                <a
                  href={`/sources?src=${encodeURIComponent(`${otherType}:${otherId}`)}`}
                  className="text-xs font-medium text-brand-teal-ink underline-offset-2 hover:underline dark:text-brand-teal"
                >
                  {t('revisions.viewOther')}
                </a>
                <Pill
                  tone={
                    revision.status === 'rejected'
                      ? 'neutral'
                      : revision.status === 'proposed'
                        ? 'info'
                        : 'positive'
                  }
                >
                  {t(`revisions.status.${revision.status}`)}
                </Pill>
              </div>
              {basis && basis.confidence !== 'manual' && (
                <p className="mt-1 text-xs text-slate-500">
                  {basis.revisionNew && basis.revisionOld
                    ? t('revisions.basisAnchored', {
                        from: basis.revisionOld,
                        to: basis.revisionNew,
                      })
                    : t('revisions.basisSimilarity', {
                        overlap: Math.round((basis.subjectOverlap ?? 0) * 100),
                        similarity: Math.round((basis.shingleSimilarity ?? 0) * 100),
                      })}
                </p>
              )}
              {revision.status === 'proposed' && (
                <div className="mt-1.5 flex gap-2">
                  <button
                    type="button"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ id: revision.id, decision: 'confirm' })}
                    className="rounded-md bg-brand-teal px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
                  >
                    {t('revisions.confirm')}
                  </button>
                  <button
                    type="button"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ id: revision.id, decision: 'reject' })}
                    className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-600 disabled:opacity-50"
                  >
                    {t('revisions.reject')}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {sourceType === 'file' && (
        <div className="mt-2">
          {linking ? (
            <ManualLinkPicker
              session={session}
              sourceType={sourceType}
              sourceId={sourceId}
              onDone={() => {
                setLinking(false);
                refresh();
              }}
              onCancel={() => setLinking(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setLinking(true)}
              className="text-xs text-slate-500 underline underline-offset-2"
            >
              {t('revisions.linkManually')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** Pick the EARLIER document this one replaces, from the owner's sources. */
function ManualLinkPicker({
  session,
  sourceType,
  sourceId,
  onDone,
  onCancel,
}: {
  session: Session;
  sourceType: string;
  sourceId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('sources');
  const [q, setQ] = useState('');
  const candidates = useQuery({
    queryKey: ['revision-candidates', q],
    queryFn: () =>
      fetchSourceCatalog(session, { type: 'file', q: q.trim() || undefined, limit: 8 }),
  });
  const link = useMutation({
    mutationFn: (predecessorId: string) =>
      linkSourceRevision(
        session,
        { sourceType, sourceId },
        { sourceType: 'file', sourceId: predecessorId },
      ),
    onSuccess: onDone,
  });
  const options = (candidates.data?.items ?? []).filter((item) => item.sourceId !== sourceId);
  return (
    <div className="space-y-1.5 rounded-md border border-slate-200 p-2.5">
      <p className="text-xs text-slate-500">{t('revisions.pickerExplainer')}</p>
      <input
        value={q}
        onChange={(event) => setQ(event.target.value)}
        placeholder={t('revisions.pickerSearch')}
        className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
      />
      <ul className="max-h-40 divide-y divide-slate-100 overflow-y-auto">
        {options.map((item) => (
          <li key={item.sourceId}>
            <button
              type="button"
              disabled={link.isPending}
              onClick={() => link.mutate(item.sourceId)}
              className="w-full truncate px-1 py-1 text-left text-sm text-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/40"
            >
              {item.name ?? item.sourceId}
            </button>
          </li>
        ))}
        {options.length === 0 && !candidates.isPending && (
          <li className="px-1 py-1 text-xs text-slate-400">{t('revisions.pickerEmpty')}</li>
        )}
      </ul>
      {link.isError && <ErrorState>{link.error.message}</ErrorState>}
      <button
        type="button"
        onClick={onCancel}
        className="text-xs text-slate-500 underline underline-offset-2"
      >
        {t('revisions.pickerCancel')}
      </button>
    </div>
  );
}

function FactRow({
  fact,
  onOpenMemory,
}: {
  fact: SourceFactDto;
  onOpenMemory?: (memoryId: string) => void;
}) {
  const { t } = useTranslation('sources');
  const verification = fact.verification;
  return (
    <li className="rounded-md border border-slate-200 p-2.5 text-sm">
      <MemoryLine content={fact.memory.content} id={fact.memory.id} onOpen={onOpenMemory} />
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
        <StatusChip status={fact.memory.status} />
        {fact.memory.uncertaintyReason && (
          <span className="text-amber-800 dark:text-amber-300">
            {t(`memories:uncertaintyReason.${fact.memory.uncertaintyReason}`)}
          </span>
        )}
      </div>
      {verification?.sourceSpan && (
        <p className="mt-1.5 text-xs italic text-slate-500">
          {t('detail.span', { span: verification.sourceSpan })}
        </p>
      )}
      {verification &&
        (verification.spanLocators ? (
          <div className="mt-1">
            <LocatorChips locators={verification.spanLocators} />
          </div>
        ) : (
          verification.sourceSpan && (
            <p className="mt-1 text-[0.68rem] text-slate-400">{t('detail.noLocation')}</p>
          )
        ))}
    </li>
  );
}

function MemoryLine({
  content,
  id,
  onOpen,
}: {
  content: string | null;
  id: string;
  onOpen?: (memoryId: string) => void;
}) {
  const { t } = useTranslation('sources');
  const text = content ?? t('detail.contentUnavailable');
  if (!onOpen) return <p className="text-slate-700">{text}</p>;
  return (
    <button
      type="button"
      onClick={() => onOpen(id)}
      className="w-full text-left text-slate-700 underline-offset-2 hover:underline"
    >
      {text}
    </button>
  );
}
