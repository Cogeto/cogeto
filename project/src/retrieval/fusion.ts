import type { MemoryStatus } from '@cogeto/shared';
import { STATUS_MULTIPLIERS } from '@cogeto/shared';
import { RRF_K } from './retrieval-config';

/**
 * Reciprocal rank fusion with the §A.5 status multipliers, as a pure function
 * so the fusion_multipliers test needs no containers.
 *
 * Order of operations is binding: the scope/sensitive gates already ran INSIDE
 * each signal's query (never here), RRF fuses the surviving ranks, and the
 * status multiplier scales the fused score. `replaced` multiplies to 0 and is
 * excluded from default retrieval; temporal queries will lift that exclusion
 * when time-travel lands (§B.2 — not in v1 retrieval).
 */

export type RetrievalSignal = 'vector' | 'fts' | 'entity';

export interface RankedList {
  signal: RetrievalSignal;
  /** Memory ids, best first. Rank is positional — raw scores stay per-signal. */
  ids: string[];
}

export interface FusedHit {
  memoryId: string;
  /** RRF sum × status multiplier. */
  score: number;
  signals: RetrievalSignal[];
}

export function fuseAndRank(
  lists: RankedList[],
  statusOf: (memoryId: string) => MemoryStatus | undefined,
  /** Temporal mode passes TEMPORAL_STATUS_MULTIPLIERS (decision 0012 ruling 5). */
  multipliers: Record<MemoryStatus, number> = STATUS_MULTIPLIERS,
): FusedHit[] {
  const fused = new Map<string, { score: number; signals: RetrievalSignal[] }>();
  for (const list of lists) {
    list.ids.forEach((memoryId, index) => {
      const entry = fused.get(memoryId) ?? { score: 0, signals: [] };
      entry.score += 1 / (RRF_K + index + 1);
      entry.signals.push(list.signal);
      fused.set(memoryId, entry);
    });
  }

  const hits: FusedHit[] = [];
  for (const [memoryId, { score, signals }] of fused) {
    const status = statusOf(memoryId);
    if (status === undefined) continue; // not resolvable through the gated read
    const multiplied = score * multipliers[status];
    if (multiplied <= 0) continue; // replaced ×0 — excluded in default mode (§A.5)
    hits.push({ memoryId, score: multiplied, signals });
  }
  // Deterministic: score desc, id asc as the tie-break.
  return hits.sort((a, b) => b.score - a.score || a.memoryId.localeCompare(b.memoryId));
}
