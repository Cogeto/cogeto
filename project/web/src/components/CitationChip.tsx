import { useQuery } from '@tanstack/react-query';
import type { ChatFactDto, MemoryStatus } from '@cogeto/shared';
import { fetchMemory } from '../api';
import type { Session } from '../auth/oidc';

/**
 * An inline citation chip in an assistant message. Live streams pass the fact
 * from the SSE sources event; persisted messages resolve the memory id via
 * GET /api/memories/:id. Uncertain and contradicted facts are visibly marked.
 * Clicking opens the source drawer for note-backed memories.
 */

const STATUS_CHIP: Record<MemoryStatus, string> = {
  active: 'bg-brand-teal/15 text-brand-teal',
  user_approved: 'bg-brand-teal/15 text-brand-teal',
  uncertain: 'bg-amber-100 text-amber-700',
  contradicted: 'bg-red-100 text-red-600',
  outdated: 'bg-slate-200 text-slate-500',
  replaced: 'bg-slate-200 text-slate-500',
};

const WARN_STATUSES: MemoryStatus[] = ['uncertain', 'contradicted'];

export interface ChipTarget {
  status: MemoryStatus;
  sourceType: string;
  sourceId: string;
  claim: string | null;
}

export function CitationChip({
  session,
  ordinal,
  memoryId,
  fact,
  onSource,
}: {
  session: Session;
  /** Position of this citation within its message, 1-based. */
  ordinal: number;
  memoryId?: string;
  fact?: ChatFactDto;
  onSource: (target: ChipTarget) => void;
}) {
  const lookupId = fact ? undefined : memoryId;
  const { data } = useQuery({
    queryKey: ['memory', lookupId],
    queryFn: () => fetchMemory(session, lookupId!),
    enabled: Boolean(lookupId),
    staleTime: 30_000,
  });

  const target: ChipTarget | null = fact
    ? {
        status: fact.status,
        sourceType: fact.sourceType,
        sourceId: fact.sourceId,
        claim: fact.claim,
      }
    : data
      ? {
          status: data.status,
          sourceType: data.sourceType,
          sourceId: data.sourceId,
          claim: data.content,
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
  return (
    <button
      type="button"
      onClick={() => onSource(target)}
      title={target.claim ?? undefined}
      className={`mx-0.5 inline-flex items-center gap-1 rounded-full px-1.5 text-xs font-semibold align-baseline ${STATUS_CHIP[target.status]}`}
    >
      {ordinal}
      {warn && <span aria-label={target.status}>⚠ {target.status.replace('_', '-')}</span>}
    </button>
  );
}
