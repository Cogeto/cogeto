import { Injectable } from '@nestjs/common';
import type { Principal } from '@cogeto/shared';
import { MemoryStore } from '../memory/index';
import type { MemoryRow } from '../memory/index';
import { ModelGateway } from '../model-gateway/index';
import { fuseAndRank } from './fusion';
import type { RankedList, RetrievalSignal } from './fusion';
import { queryEntityCandidates } from './query-entities';
import { DEFAULT_TOP_K, SIGNAL_FETCH_FACTOR } from './retrieval-config';

export interface RetrieveOptions {
  topK?: number;
  /** Decision 0003 ruling 3: explicit per-query opt-in; owner-only even then. */
  includeSensitive?: boolean;
}

export interface RetrievedMemory {
  memory: MemoryRow;
  /** Fused score (RRF × status multiplier) — comparable within one result list only. */
  score: number;
  /** Which of the three §A.5 signals surfaced this memory. */
  signals: RetrievalSignal[];
}

/**
 * Hybrid retrieval (§A.5): three gated signals from the memory module's public
 * interface — vector (Qdrant), keyword FTS, trigram entity match — fused with
 * reciprocal rank fusion, then the status multipliers. This module never
 * touches a table or a client (decision 0003 ruling 2); every row it handles
 * already passed the scope/sensitive gates inside the memory module's SQL.
 *
 * Fast path: the only model call is the query embedding (one gateway call);
 * query entities come from the capitalized-token heuristic. No temporal
 * queries yet — that lift arrives with time-travel (§B.2).
 */
@Injectable()
export class RetrievalService {
  constructor(
    private readonly memoryStore: MemoryStore,
    private readonly gateway: ModelGateway,
  ) {}

  async retrieve(
    principal: Principal,
    query: string,
    opts: RetrieveOptions = {},
  ): Promise<RetrievedMemory[]> {
    const topK = opts.topK ?? DEFAULT_TOP_K;
    const searchOpts = {
      topK: topK * SIGNAL_FETCH_FACTOR, // over-fetch before fusion (research §1)
      includeSensitive: opts.includeSensitive,
    };

    const [vectorHits, ftsHits, entityHits] = await Promise.all([
      this.gateway
        .embed([query])
        .then(([embedding]) => this.memoryStore.vectorSearch(principal, embedding!, searchOpts)),
      this.memoryStore.ftsSearch(principal, query, searchOpts),
      this.memoryStore.entitySearch(principal, queryEntityCandidates(query), searchOpts),
    ]);

    // Rows from FTS/entity arrived with their hits; vector hits are ids and
    // resolve through the gated batch read (same gates — a Qdrant payload can
    // never be the last line of defense).
    const rowsById = new Map<string, MemoryRow>();
    for (const { memory } of [...ftsHits, ...entityHits]) rowsById.set(memory.id, memory);
    const unresolved = vectorHits.map((h) => h.memoryId).filter((id) => !rowsById.has(id));
    for (const row of await this.memoryStore.getManyForPrincipal(principal, unresolved, opts)) {
      rowsById.set(row.id, row);
    }

    const lists: RankedList[] = [
      { signal: 'vector', ids: vectorHits.map((h) => h.memoryId) },
      { signal: 'fts', ids: ftsHits.map((h) => h.memory.id) },
      { signal: 'entity', ids: entityHits.map((h) => h.memory.id) },
    ];
    return fuseAndRank(lists, (id) => rowsById.get(id)?.status)
      .slice(0, topK)
      .map((hit) => ({
        memory: rowsById.get(hit.memoryId)!,
        score: hit.score,
        signals: hit.signals,
      }));
  }
}
