import { useQuery } from '@tanstack/react-query';
import type { ChatFactDto, MemoryStatus } from '@cogeto/shared';
import { fetchMe, fetchMemory } from '../api';
import type { Session } from '../auth/oidc';
import { CITATION_STALE_MS } from '../query-invalidation';
import { isPastFact, PAST_CHIP, STATUS_CHIP, statusLabel, WARN_STATUSES } from './status';

/**
 * An inline citation chip in an assistant message. Live streams pass the fact
 * from the SSE sources event; persisted messages resolve the memory id via
 * GET /api/memories/:id. Uncertain and contradicted facts are visibly marked.
 * Clicking opens the governance drawer in place when the page provides an
 * onOpen handler (chat); otherwise it deep-links to /memories.
 */
export function CitationChip({
  session,
  ordinal,
  memoryId,
  fact,
  onOpen,
}: {
  session: Session;
  /** Position of this citation within its message, 1-based. */
  ordinal: number;
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
        }
      : null;

  if (!target) {
    return (
      <span className="mx-0.5 inline-block rounded-full bg-slate-100 px-1.5 text-xs text-slate-400">
        {ordinal}
      </span>
    );
  }
  const warn = WARN_STATUSES.includes(target.status);
  // Past belief renders muted and labeled "past" (decision 0012 ruling 6);
  // a warning status still wins the styling contest — a disputed past fact
  // stays visibly disputed.
  const chipStyle = warn
    ? STATUS_CHIP[target.status]
    : target.past
      ? PAST_CHIP
      : STATUS_CHIP[target.status];
  // Attribute a cited SHARED fact owned by someone else (O2-B).
  const sharedByOther = target.scope === 'shared' && target.ownerId !== me?.userId;
  const ownerLabel = target.ownerName ?? 'a teammate';
  const className = `mx-0.5 inline-flex items-center gap-1 rounded-full px-1.5 align-baseline text-xs font-semibold no-underline ${chipStyle}`;
  const title = [target.claim, sharedByOther ? `shared by ${ownerLabel}` : null]
    .filter(Boolean)
    .join(' — ');
  const label = (
    <>
      {ordinal}
      {warn && <span aria-label={target.status}>⚠ {statusLabel(target.status)}</span>}
      {!warn && target.past && <span aria-label="past belief">past</span>}
      {sharedByOther && (
        <span aria-label={`shared by ${ownerLabel}`} className="text-sky-700">
          · {ownerLabel}
        </span>
      )}
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
