import { useQuery } from '@tanstack/react-query';
import type { ChatFactDto, MemoryStatus } from '@cogeto/shared';
import { fetchMemory } from '../api';
import type { Session } from '../auth/oidc';
import { STATUS_CHIP, statusLabel, WARN_STATUSES } from './status';

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
    staleTime: 30_000,
  });

  const target = fact
    ? { memoryId: fact.memoryId, status: fact.status, claim: fact.claim }
    : data
      ? { memoryId: data.id, status: data.status as MemoryStatus, claim: data.content }
      : null;

  if (!target) {
    return (
      <span className="mx-0.5 inline-block rounded-full bg-slate-100 px-1.5 text-xs text-slate-400">
        {ordinal}
      </span>
    );
  }
  const warn = WARN_STATUSES.includes(target.status);
  const className = `mx-0.5 inline-flex items-center gap-1 rounded-full px-1.5 align-baseline text-xs font-semibold no-underline ${STATUS_CHIP[target.status]}`;
  const label = (
    <>
      {ordinal}
      {warn && <span aria-label={target.status}>⚠ {statusLabel(target.status)}</span>}
    </>
  );
  return onOpen ? (
    <button
      type="button"
      onClick={() => onOpen(target.memoryId)}
      title={target.claim ?? undefined}
      className={className}
    >
      {label}
    </button>
  ) : (
    <a
      href={`/memories?open=${target.memoryId}`}
      title={target.claim ?? undefined}
      className={className}
    >
      {label}
    </a>
  );
}
