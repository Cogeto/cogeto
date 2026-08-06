import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { SourceFactDto } from '@cogeto/shared';
import { fetchSourceInspection } from '../api';
import type { Session } from '../auth/oidc';
import { LocatorChips } from './LocatorChips';
import { ErrorState, SkeletonRows, StatusChip } from './ui';
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
