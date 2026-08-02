import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { isRegisteredSourceType } from '@cogeto/shared';
import type { ChatFactDto, MemoryStatus, SourceTypeKey } from '@cogeto/shared';
import { fetchMe, fetchMemory, fetchWebSource } from '../api';
import type { Session } from '../auth/oidc';
import { i18next } from '../i18n';
import { formatDateTime, formatDayMonth } from '../i18n/format';
import { CITATION_STALE_MS } from '../query-invalidation';
import { isPastFact, statusLabel, WARN_STATUSES } from './status';

/**
 * An inline citation chip in an assistant message. Live streams pass the fact
 * from the SSE sources event; persisted messages resolve the memory id via
 * GET /api/memories/:id. Uncertain and contradicted facts are visibly marked.
 * A web-sourced fact renders as a web chip carrying its URL and
 * fetch time, matching the research answer's treatment.
 * Clicking opens the governance drawer in place when the page provides an
 * onOpen handler (chat); otherwise it deep-links to /memories.
 */
/**
 * Friendly, short source kind for the provenance chip. The source TYPE is an
 * API value; only its display name is translated, through an explicit
 * value → key map, typed over the source-type registry's union so adding a
 * source type without deciding its chip label is a compile error. `null` and
 * an unrecognised runtime value render verbatim, as before.
 */
const CITATION_KIND_KEY: Record<SourceTypeKey, string | null> = {
  user_note: 'chat:citation.kind.note',
  chat: 'chat:citation.kind.chat',
  email: 'chat:citation.kind.email',
  web: 'chat:citation.kind.web',
  file: null,
  chat_conversation: null,
  calendar_event: null,
  task_conclusion: null,
};

function sourceKind(sourceType: string): string {
  const key = isRegisteredSourceType(sourceType) ? CITATION_KIND_KEY[sourceType] : null;
  return key ? i18next.t(key) : sourceType.replace(/_/g, ' ');
}

export function CitationChip({
  session,
  memoryId,
  fact,
  onOpen,
}: {
  session: Session;
  memoryId?: string;
  fact?: ChatFactDto;
  onOpen?: (memoryId: string) => void;
}) {
  const { t } = useTranslation('chat');
  const lookupId = fact ? undefined : memoryId;
  const { data } = useQuery({
    queryKey: ['memory', lookupId],
    queryFn: () => fetchMemory(session, lookupId!),
    enabled: Boolean(lookupId),
    // A cited memory's status is refreshed by targeted invalidation on any
    // governance mutation; this stale window just bounds passive drift.
    staleTime: CITATION_STALE_MS,
  });
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => fetchMe(session) });

  const target = fact
    ? {
        memoryId: fact.memoryId,
        status: fact.status,
        claim: fact.claim,
        past: fact.pastBelief,
        scope: fact.scope,
        ownerId: fact.ownerId,
        ownerName: fact.ownerName,
        sourceType: fact.sourceType,
        sourceId: fact.sourceId,
      }
    : data
      ? {
          memoryId: data.id,
          status: data.status as MemoryStatus,
          claim: data.content,
          past: isPastFact(data.status as MemoryStatus, data.validUntil),
          scope: data.scope,
          ownerId: data.ownerId,
          ownerName: data.ownerName,
          sourceType: data.sourceType,
          sourceId: data.sourceId,
        }
      : null;

  // A web-sourced fact resolves its page for the URL + fetch-time treatment
  // (built in); the drawer still holds the full provenance.
  const webSourceId = target?.sourceType === 'web' ? target.sourceId : undefined;
  const { data: webSource } = useQuery({
    queryKey: ['web-source', webSourceId],
    queryFn: () => fetchWebSource(session, webSourceId!),
    enabled: Boolean(webSourceId),
    staleTime: CITATION_STALE_MS,
  });

  if (!target) {
    return (
      <span className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-slate-200 px-1.5 align-baseline font-mono text-[0.72rem] text-slate-400">
        <span aria-hidden="true">◈</span>
        {t('citation.unresolved')}
      </span>
    );
  }
  const warn = WARN_STATUSES.includes(target.status);
  const isWeb = target.sourceType === 'web';
  const kind = sourceKind(target.sourceType);
  const dateLabel = fact?.validFrom ? formatDayMonth(fact.validFrom) : null;
  // Provenance chip: a mono "◈ kind" token, tinted by state. Warning
  // statuses win the styling contest (a disputed fact stays visibly disputed);
  // then past-belief muted, then the teal/sky memory-vs-web split.
  const tone =
    target.status === 'contradicted'
      ? 'border-red-400/40 bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'
      : target.status === 'uncertain'
        ? 'border-amber-400/40 bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300'
        : target.past
          ? 'border-slate-300 bg-slate-100 text-slate-600'
          : isWeb
            ? 'border-sky-400/40 bg-sky-400/10 text-sky-700 dark:text-sky-300'
            : 'border-brand-teal/30 bg-brand-teal/10 text-brand-teal-ink dark:text-brand-teal';
  // Attribute a cited SHARED fact owned by someone else.
  const sharedByOther = target.scope === 'shared' && target.ownerId !== me?.userId;
  const ownerLabel = target.ownerName ?? t('citation.teammate');
  const className = `mx-0.5 inline-flex items-center gap-1 rounded-md border px-1.5 align-baseline font-mono text-[0.72rem] font-medium no-underline transition-shadow hover:shadow-sm ${tone}`;
  const webDetail = webSource
    ? t('citation.webDetail', {
        title: webSource.title ?? webSource.finalUrl,
        when: formatDateTime(webSource.fetchedAt),
      })
    : isWeb
      ? t('citation.fromWeb')
      : null;
  const title = [
    target.claim,
    webDetail,
    sharedByOther ? t('citation.sharedBy', { owner: ownerLabel }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const label = (
    <>
      <span aria-hidden="true" className="opacity-80">
        ◈
      </span>
      {kind}
      {dateLabel && <span className="font-normal opacity-70">· {dateLabel}</span>}
      {warn && <span aria-hidden="true">· ⚠</span>}
      {!warn && target.past && <span className="opacity-80">{t('citation.pastSuffix')}</span>}
      {sharedByOther && <span className="text-sky-700 dark:text-sky-300">· {ownerLabel}</span>}
      <span className="sr-only">
        {' '}
        {t('citation.screenReader', { kind })}
        {warn ? t('citation.screenReaderStatus', { status: statusLabel(target.status) }) : ''}
        {!warn && target.past ? t('citation.screenReaderPast') : ''}
        {sharedByOther ? t('citation.screenReaderShared', { owner: ownerLabel }) : ''}
      </span>
    </>
  );
  return onOpen ? (
    <button
      type="button"
      onClick={() => onOpen(target.memoryId)}
      title={title || undefined}
      className={className}
    >
      {label}
    </button>
  ) : (
    <a href={`/memories?open=${target.memoryId}`} title={title || undefined} className={className}>
      {label}
    </a>
  );
}
