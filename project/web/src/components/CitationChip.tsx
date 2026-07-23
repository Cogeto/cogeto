import { useQuery } from '@tanstack/react-query';
import type { ChatFactDto, MemoryStatus } from '@cogeto/shared';
import { fetchMe, fetchMemory, fetchWebSource } from '../api';
import type { Session } from '../auth/oidc';
import { CITATION_STALE_MS } from '../query-invalidation';
import { isPastFact, statusLabel, WARN_STATUSES } from './status';

/**
 * An inline citation chip in an assistant message. Live streams pass the fact
 * from the SSE sources event; persisted messages resolve the memory id via
 * GET /api/memories/:id. Uncertain and contradicted facts are visibly marked.
 * A web-sourced fact (Priority 5) renders as a web chip carrying its URL and
 * fetch time, matching the research answer's treatment (decision 0046).
 * Clicking opens the governance drawer in place when the page provides an
 * onOpen handler (chat); otherwise it deep-links to /memories.
 */
/** Friendly, short source kind for the provenance chip (P6.9). */
function sourceKind(sourceType: string): string {
  switch (sourceType) {
    case 'user_note':
    case 'note':
      return 'note';
    case 'email':
      return 'email';
    case 'web':
      return 'web';
    case 'file_upload':
      return 'doc';
    case 'chat':
      return 'chat';
    default:
      return sourceType.replace(/_/g, ' ');
  }
}
const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

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
  const lookupId = fact ? undefined : memoryId;
  const { data } = useQuery({
    queryKey: ['memory', lookupId],
    queryFn: () => fetchMemory(session, lookupId!),
    enabled: Boolean(lookupId),
    // A cited memory's status is refreshed by targeted invalidation on any
    // governance mutation (QS-36); this stale window just bounds passive drift.
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
  // (built in Priority 5); the drawer still holds the full provenance.
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
        <span aria-hidden="true">◈</span>source
      </span>
    );
  }
  const warn = WARN_STATUSES.includes(target.status);
  const isWeb = target.sourceType === 'web';
  const kind = sourceKind(target.sourceType);
  const dateLabel = fact?.validFrom ? shortDate(fact.validFrom) : null;
  // Provenance chip (P6.9): a mono "◈ kind" token, tinted by state. Warning
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
  // Attribute a cited SHARED fact owned by someone else (O2-B).
  const sharedByOther = target.scope === 'shared' && target.ownerId !== me?.userId;
  const ownerLabel = target.ownerName ?? 'a teammate';
  const className = `mx-0.5 inline-flex items-center gap-1 rounded-md border px-1.5 align-baseline font-mono text-[0.72rem] font-medium no-underline transition-shadow hover:shadow-sm ${tone}`;
  const webDetail = webSource
    ? `${webSource.title ?? webSource.finalUrl} · fetched ${new Date(webSource.fetchedAt).toLocaleString()}`
    : isWeb
      ? 'from the web'
      : null;
  const title = [target.claim, webDetail, sharedByOther ? `shared by ${ownerLabel}` : null]
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
      {!warn && target.past && <span className="opacity-80">· past</span>}
      {sharedByOther && <span className="text-sky-700 dark:text-sky-300">· {ownerLabel}</span>}
      <span className="sr-only">
        {' '}
        citation from {kind}
        {warn ? `, ${statusLabel(target.status)}` : ''}
        {!warn && target.past ? ', past belief' : ''}
        {sharedByOther ? `, shared by ${ownerLabel}` : ''}
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
