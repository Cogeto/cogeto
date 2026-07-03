import { Injectable } from '@nestjs/common';
import type { Principal } from '@cogeto/shared';
import { MemoryStore } from '../memory/index';
import type { MemoryRow } from '../memory/index';
import { ModelGateway } from '../model-gateway/index';
import {
  byStatusThenRecency,
  detectEntityProfile,
  dominantEntity,
  mentionsEntity,
  nameVariants,
} from './entity-profile';
import { fuseAndRank } from './fusion';
import type { RankedList, RetrievalSignal } from './fusion';
import { queryEntityCandidates } from './query-entities';
import { rewriteQuery } from './query-rewrite';
import type { ConversationTurn } from './query-rewrite';
import { DEFAULT_TOP_K, PROFILE_CEILING, SIGNAL_FETCH_FACTOR } from './retrieval-config';

export interface RetrieveOptions {
  topK?: number;
  /** Decision 0003 ruling 3: explicit per-query opt-in; owner-only even then. */
  includeSensitive?: boolean;
  /** Recent conversation turns (oldest first) for pronoun/ellipsis rewriting (F3). */
  history?: ConversationTurn[];
}

export interface RetrievedMemory {
  memory: MemoryRow;
  /** Fused score (RRF × status multiplier) — comparable within one result list only. */
  score: number;
  /** Which of the three §A.5 signals surfaced this memory. */
  signals: RetrievalSignal[];
}

/** What retrieval decided, so the answerer can adapt (F1/F4). */
export type RetrievalMode = 'default' | 'entity_profile';

export interface RetrievalResult {
  memories: RetrievedMemory[];
  mode: RetrievalMode;
  /** The entity a profile was built for, when mode is entity_profile. */
  focusEntity?: string;
}

/**
 * Hybrid retrieval (§A.5): three gated signals from the memory module's public
 * interface — vector (Qdrant), keyword FTS, trigram entity match — fused with
 * reciprocal rank fusion, then the status multipliers. This module never
 * touches a table or a client (decision 0003 ruling 2); every row it handles
 * already passed the scope/sensitive gates inside the memory module's SQL.
 *
 * Fast path (S3.5-B): one bounded rewriter call resolves conversational
 * references (F3); an entity-profile question triggers an exhaustive gather of
 * that entity's memories (F1/F4); a project/topic question with a dominant
 * entity widens once via entity search before answering (F5).
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
  ): Promise<RetrievalResult> {
    const topK = opts.topK ?? DEFAULT_TOP_K;

    // 1. Conversational rewriting (F3): resolve "who is she?" to its referent.
    const rewrite = await rewriteQuery(this.gateway, opts.history ?? [], query);
    const searchQuery = rewrite.query;
    const entityCandidates = [
      ...new Set([...rewrite.entities, ...queryEntityCandidates(searchQuery)]),
    ];

    // 2. Entity-profile mode (F1/F4): exhaustive gather, no top-k truncation.
    const focus = detectEntityProfile(searchQuery, entityCandidates);
    if (focus) {
      const memories = await this.gatherEntityProfile(principal, focus, searchQuery, opts);
      if (memories.length > 0) return { memories, mode: 'entity_profile', focusEntity: focus };
      // Nothing on record for this entity — fall through to normal retrieval.
    }

    // 3. Default hybrid fusion.
    let results = await this.fuse(principal, searchQuery, entityCandidates, topK, opts);

    // 4. Project/topic aggregation (F5): if the results cluster on one entity,
    // widen once via entity search so the answer sees the whole picture.
    const dominant = dominantEntity(results.map((r) => r.memory));
    if (dominant) {
      results = await this.fuse(
        principal,
        searchQuery,
        [...entityCandidates, dominant],
        topK,
        opts,
        {
          widenEntity: dominant,
        },
      );
    }
    return { memories: results, mode: 'default' };
  }

  /** Default fusion over the three gated signals, resolved to ranked rows. */
  private async fuse(
    principal: Principal,
    query: string,
    entityCandidates: string[],
    topK: number,
    opts: RetrieveOptions,
    extra?: { widenEntity: string },
  ): Promise<RetrievedMemory[]> {
    const searchOpts = {
      topK: topK * SIGNAL_FETCH_FACTOR, // over-fetch before fusion (research §1)
      includeSensitive: opts.includeSensitive,
    };
    const widenNames = extra ? nameVariants(extra.widenEntity) : [];
    const [vectorHits, ftsHits, entityHits, widenHits] = await Promise.all([
      this.gateway
        .embed([query])
        .then(([embedding]) => this.memoryStore.vectorSearch(principal, embedding!, searchOpts)),
      this.memoryStore.ftsSearch(principal, query, searchOpts),
      this.memoryStore.entitySearch(principal, entityCandidates, searchOpts),
      widenNames.length
        ? this.memoryStore.entitySearch(principal, widenNames, {
            topK: PROFILE_CEILING,
            includeSensitive: opts.includeSensitive,
          })
        : Promise.resolve([]),
    ]);

    const rowsById = new Map<string, MemoryRow>();
    for (const { memory } of [...ftsHits, ...entityHits, ...widenHits])
      rowsById.set(memory.id, memory);
    const unresolved = vectorHits.map((h) => h.memoryId).filter((id) => !rowsById.has(id));
    for (const row of await this.memoryStore.getManyForPrincipal(principal, unresolved, opts)) {
      rowsById.set(row.id, row);
    }

    const lists: RankedList[] = [
      { signal: 'vector', ids: vectorHits.map((h) => h.memoryId) },
      { signal: 'fts', ids: ftsHits.map((h) => h.memory.id) },
      { signal: 'entity', ids: [...entityHits, ...widenHits].map((h) => h.memory.id) },
    ];
    // Widening lets the answer aggregate more than the default slice.
    const limit = extra ? Math.max(topK, PROFILE_CEILING) : topK;
    return fuseAndRank(lists, (id) => rowsById.get(id)?.status)
      .slice(0, limit)
      .map((hit) => ({
        memory: rowsById.get(hit.memoryId)!,
        score: hit.score,
        signals: hit.signals,
      }));
  }

  /**
   * Exhaustive gather of everything about one entity (F1/F4): all entity-search
   * matches for the entity's name variants, plus vector hits that actually
   * concern the entity (never an unrelated neighbour — that is the F1 trap),
   * deduplicated, ordered by trust then recency, capped at a sane ceiling.
   */
  private async gatherEntityProfile(
    principal: Principal,
    focus: string,
    query: string,
    opts: RetrieveOptions,
  ): Promise<RetrievedMemory[]> {
    const searchOpts = { topK: PROFILE_CEILING, includeSensitive: opts.includeSensitive };
    const [entityHits, vectorHits] = await Promise.all([
      this.memoryStore.entitySearch(principal, nameVariants(focus), searchOpts),
      this.gateway
        .embed([query])
        .then(([embedding]) => this.memoryStore.vectorSearch(principal, embedding!, searchOpts)),
    ]);

    const rowsById = new Map<string, MemoryRow>();
    const signalsById = new Map<string, Set<RetrievalSignal>>();
    const note = (id: string, signal: RetrievalSignal) => {
      (signalsById.get(id) ?? signalsById.set(id, new Set()).get(id)!).add(signal);
    };

    for (const { memory } of entityHits) {
      rowsById.set(memory.id, memory);
      note(memory.id, 'entity');
    }
    // Vector supplements — only those that genuinely concern the entity.
    const vectorIds = vectorHits.map((h) => h.memoryId).filter((id) => !rowsById.has(id));
    for (const row of await this.memoryStore.getManyForPrincipal(principal, vectorIds, opts)) {
      if (mentionsEntity(row, focus)) {
        rowsById.set(row.id, row);
        note(row.id, 'vector');
      }
    }

    return [...rowsById.values()]
      .filter((row) => row.status !== 'replaced') // replaced ×0 — excluded (§A.5)
      .sort(byStatusThenRecency)
      .map((memory) => ({ memory, score: 0, signals: [...(signalsById.get(memory.id) ?? [])] }));
  }
}
