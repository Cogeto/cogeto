import { Inject, Injectable, Optional } from '@nestjs/common';
import type { MemoryStatus, Principal } from '@cogeto/shared';
import { TEMPORAL_STATUS_MULTIPLIERS } from '@cogeto/shared';
import { DEFAULT_INSTANCE_TIMEZONE, INSTANCE_TIMEZONE } from '../infrastructure/index';
import { MemoryStore } from '../memory/index';
import type { MemoryChange, MemoryRow } from '../memory/index';
import { TasksEngine } from '../tasks/index';
import type { TaskRow } from '../tasks/index';
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
import type { ConversationTurn, TemporalIntent } from './query-rewrite';
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

/** What retrieval decided, so the answerer can adapt (F1/F4, F3-A, F3-B). */
export type RetrievalMode = 'default' | 'entity_profile' | 'temporal' | 'tasks';

export interface RetrievalResult {
  memories: RetrievedMemory[];
  mode: RetrievalMode;
  /** The entity a profile was built for, when mode is entity_profile. */
  focusEntity?: string;
  /** The classified temporal intent, when mode is temporal (decision 0012). */
  temporal?: TemporalIntent;
  /** The change events, when the temporal kind is change_since. */
  changes?: MemoryChange[];
  /** The open/blocked tasks, when mode is tasks (decision 0013 ruling 7). */
  tasks?: TaskRow[];
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
    private readonly tasksEngine: TasksEngine,
    // Instance timezone for relative-date resolution in query rewriting (QS-32).
    @Optional()
    @Inject(INSTANCE_TIMEZONE)
    private readonly timeZone: string = DEFAULT_INSTANCE_TIMEZONE,
  ) {}

  async retrieve(
    principal: Principal,
    query: string,
    opts: RetrieveOptions = {},
  ): Promise<RetrievalResult> {
    const topK = opts.topK ?? DEFAULT_TOP_K;

    // 1. Conversational rewriting (F3): resolve "who is she?" to its referent.
    const rewrite = await rewriteQuery(
      this.gateway,
      opts.history ?? [],
      query,
      undefined,
      undefined,
      this.timeZone,
    );
    const searchQuery = rewrite.query;
    const entityCandidates = [
      ...new Set([...rewrite.entities, ...queryEntityCandidates(searchQuery)]),
    ];

    // 2. Open-loops mode (F3-B, decision 0013 ruling 7): the day-one
    // question's second half. Owner-scoped task reads; citations resolve to
    // the deriving memories through the gated read.
    if (rewrite.openLoops) {
      const tasks = await this.tasksEngine.listForPrincipal(principal, {
        entity: rewrite.openLoops.entity ?? undefined,
      });
      const derivingRows = await this.memoryStore.getManyForPrincipal(
        principal,
        tasks.map((t) => t.derivedFromMemoryId),
        opts,
      );
      return {
        memories: derivingRows.map((memory) => ({ memory, score: 0, signals: [] })),
        mode: 'tasks',
        tasks,
      };
    }

    // 3. Temporal mode (F3-A, decision 0012): explicit intent only — the
    // rewriter classified it AND the raw question carried a temporal hint.
    if (rewrite.temporal) {
      return this.temporalRetrieve(principal, searchQuery, entityCandidates, rewrite.temporal, {
        ...opts,
        topK,
      });
    }

    // 3. Entity-profile mode (F1/F4): exhaustive gather, no top-k truncation.
    const focus = detectEntityProfile(searchQuery, entityCandidates);
    if (focus) {
      const memories = await this.gatherEntityProfile(principal, focus, searchQuery, opts);
      if (memories.length > 0) return { memories, mode: 'entity_profile', focusEntity: focus };
      // Nothing on record for this entity — fall through to normal retrieval.
    }

    // 4. Default hybrid fusion.
    let results = await this.fuse(principal, searchQuery, entityCandidates, topK, opts);

    // 5. Project/topic aggregation (F5): if the results cluster on one entity,
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

  /**
   * Temporal retrieval (decision 0012): 'previous' is the standard fused
   * search with the exclusion lifted (temporal multipliers) — past facts rank
   * nearly on par and carry their history; 'point_in_time' and 'change_since'
   * use the memory module's temporal primitives. Gates unchanged everywhere.
   */
  private async temporalRetrieve(
    principal: Principal,
    query: string,
    entityCandidates: string[],
    temporal: TemporalIntent,
    opts: RetrieveOptions & { topK: number },
  ): Promise<RetrievalResult> {
    if (temporal.kind === 'previous') {
      const memories = await this.fuse(principal, query, entityCandidates, opts.topK, opts, {
        multipliers: TEMPORAL_STATUS_MULTIPLIERS,
      });
      return { memories, mode: 'temporal', temporal };
    }

    if (temporal.kind === 'point_in_time') {
      const [embedding] = await this.gateway.embed([query]);
      const hits = await this.memoryStore.pointInTime(principal, temporal.at!, {
        topK: opts.topK,
        embedding,
        entities: entityCandidates,
        includeSensitive: opts.includeSensitive,
      });
      return {
        memories: hits.map((hit) => ({
          memory: hit.memory,
          score: hit.score ?? 0,
          signals: hit.score !== null ? (['vector'] as RetrievalSignal[]) : [],
        })),
        mode: 'temporal',
        temporal,
      };
    }

    const changes = await this.memoryStore.changesSince(principal, temporal.since!, {
      includeSensitive: opts.includeSensitive,
      limit: Math.max(opts.topK, 20),
    });
    // The events' memories become the citable facts, deduplicated.
    const byId = new Map<string, MemoryRow>();
    for (const change of changes) byId.set(change.memory.id, change.memory);
    return {
      memories: [...byId.values()].map((memory) => ({ memory, score: 0, signals: [] })),
      mode: 'temporal',
      temporal,
      changes,
    };
  }

  /** Default fusion over the three gated signals, resolved to ranked rows. */
  private async fuse(
    principal: Principal,
    query: string,
    entityCandidates: string[],
    topK: number,
    opts: RetrieveOptions,
    extra?: { widenEntity?: string; multipliers?: Record<MemoryStatus, number> },
  ): Promise<RetrievedMemory[]> {
    const searchOpts = {
      topK: topK * SIGNAL_FETCH_FACTOR, // over-fetch before fusion (research §1)
      includeSensitive: opts.includeSensitive,
    };
    const widenNames = extra?.widenEntity ? nameVariants(extra.widenEntity) : [];
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
    const limit = extra?.widenEntity ? Math.max(topK, PROFILE_CEILING) : topK;
    return fuseAndRank(lists, (id) => rowsById.get(id)?.status, extra?.multipliers)
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
