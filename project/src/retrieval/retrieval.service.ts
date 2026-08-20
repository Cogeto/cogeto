import { Inject, Injectable, Optional } from '@nestjs/common';
import type { AmbiguityDecisionDto, MemoryStatus, Principal } from '@cogeto/shared';
import { resolveSpaceId, TEMPORAL_STATUS_MULTIPLIERS } from '@cogeto/shared';
import { DEFAULT_INSTANCE_TIMEZONE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { EMPTY_ALIAS_INDEX, EntityAliasStore, listOpenDormantFlags } from '../ingestion/index';
import { clusterBySubject, decideAmbiguity } from './ambiguity';
import type { EntityKeyOf } from './ambiguity';
import { AMBIGUITY_CONFIG_VERSION, ambiguityThresholdsFor } from './ambiguity-config';
import { MemoryStore } from '../memory/index';
import type { MemoryChange, MemoryRow } from '../memory/index';
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
import type { ConversationTurn, RewriteResult, TemporalIntent } from './query-rewrite';
import { DEFAULT_TOP_K, PROFILE_CEILING, SIGNAL_FETCH_FACTOR } from './retrieval-config';

export interface RetrieveOptions {
  topK?: number;
  /** Decision 0003 ruling 3: explicit per-query opt-in; owner-only even then. */
  includeSensitive?: boolean;
  /** Recent conversation turns (oldest first) for pronoun/ellipsis rewriting (F3). */
  history?: ConversationTurn[];
  /**
   * A precomputed rewrite from the chat router: retrieval
   * reuses it instead of calling the rewriter again, so routing + retrieval
   * cost exactly one bounded pipeline-tier call per turn.
   */
  rewrite?: RewriteResult;
  /**
   * Compute the spec §7.5 ambiguity decision over the fused results (V2.3
   * item 6.3). Chat's grounded answer path opts in; other callers (attention,
   * reply drafts, skills, research) neither need nor pay for it.
   */
  ambiguity?: boolean;
  /**
   * THE PROJECT RETRIEVAL LENS (V2.5 item 8.3): narrow this query to a
   * bounded set of sources. A FILTER, not a gate. Retrieval does not resolve
   * it and does not know what a project is: chat resolves the conversation's
   * project and passes the refs as a value, so this module stays pure search
   * and the memory module never joins to a projects table.
   *
   * Absent means no lens, which is the pre-feature path exactly. An EMPTY
   * array is a lens over a project with no sources, and matches nothing.
   */
  lens?: readonly { sourceType: string; sourceId: string }[];
}

export interface RetrievedMemory {
  memory: MemoryRow;
  /** Fused score (RRF × status multiplier) — comparable within one result list only. */
  score: number;
  /** Which of the three spec §3.4 signals surfaced this memory. */
  signals: RetrievalSignal[];
  /**
   * Normalized [0,1] vector similarity when the vector signal surfaced this
   * memory; null otherwise (V2.3 item 6.3). Carried BESIDE the fused score,
   * never re-applied to it: it is the one score with absolute meaning, which
   * is what the ambiguity relevance floor needs and rank-derived RRF cannot
   * provide.
   */
  vectorScore: number | null;
}

/** What retrieval decided, so the answerer can adapt (F1/F4). */
export type RetrievalMode = 'default' | 'entity_profile' | 'temporal' | 'open_loops';

/**
 * One standing obligation: the memory itself,
 * plus the one signal that does not live on it — ingestion's dormant flag.
 * Its due date is the memory's own `valid_until`; its wording is the memory's
 * own content, so the answer cites the fact directly.
 */
export interface OpenLoop {
  memory: MemoryRow;
  /** Ingestion's dormant flag stands open for this memory: it has gone quiet. */
  dormant: boolean;
}

export interface RetrievalResult {
  memories: RetrievedMemory[];
  mode: RetrievalMode;
  /** The entity a profile was built for, when mode is entity_profile. */
  focusEntity?: string;
  /** The classified temporal intent, when mode is temporal. */
  temporal?: TemporalIntent;
  /** The change events, when the temporal kind is change_since. */
  changes?: MemoryChange[];
  /** What is still standing, when mode is open_loops. */
  openLoops?: OpenLoop[];
  /**
   * The spec §7.5 ambiguity decision, present when the caller opted in AND
   * the default fused mode ran (V2.3 item 6.3). The explicit modes (a named
   * profile subject, a temporal intent, open loops) carry none: their
   * subject or shape was decided upstream of fusion and cannot mis-branch,
   * so an absent record reads "not computed", exactly like pre-feature rows.
   */
  ambiguity?: AmbiguityDecisionDto;
}

/**
 * Hybrid retrieval (spec §3.4): three gated signals from the memory module's public
 * interface — vector (Qdrant), keyword FTS, trigram entity match — fused with
 * reciprocal rank fusion, then the status multipliers. This module never
 * touches a table or a client; every row it handles
 * already passed the scope/sensitive gates inside the memory module's SQL.
 *
 * Fast path: one bounded rewriter call resolves conversational
 * references (F3); an entity-profile question triggers an exhaustive gather of
 * that entity's memories (F1/F4); a project/topic question with a dominant
 * entity widens once via entity search before answering (F5).
 */
/**
 * RetrievalService's optional collaborators, by NAME (V2.0 item 3.6 part 4):
 * a named field cannot shift the way a trailing positional optional can.
 */
export interface RetrievalServiceOptions {
  /**
   * Read-only handle for ingestion's dormant-flag consumption API (F2
   * handoff §3) — the one open-loops signal that is not on the memory row.
   * Absent in bare test constructions; without it open loops simply carry no
   * "gone quiet" marker.
   */
  db?: Db;
  /** Instance timezone for relative-date resolution in query rewriting. */
  timeZone?: string;
}

export const RETRIEVAL_SERVICE_OPTIONS = Symbol('RETRIEVAL_SERVICE_OPTIONS');

@Injectable()
export class RetrievalService {
  private readonly db?: Db;
  private readonly timeZone: string;

  constructor(
    private readonly memoryStore: MemoryStore,
    private readonly gateway: ModelGateway,
    /** Every optional collaborator, by NAME — see RetrievalServiceOptions. */
    @Optional() @Inject(RETRIEVAL_SERVICE_OPTIONS) options?: RetrievalServiceOptions,
  ) {
    this.db = options?.db;
    this.timeZone = options?.timeZone ?? DEFAULT_INSTANCE_TIMEZONE;
  }

  async retrieve(
    principal: Principal,
    query: string,
    opts: RetrieveOptions = {},
  ): Promise<RetrievalResult> {
    const topK = opts.topK ?? DEFAULT_TOP_K;

    // 1. Conversational rewriting (F3): resolve "who is she?" to its referent.
    // The chat router precomputes this; other callers still
    // rewrite here.
    const rewrite =
      opts.rewrite ??
      (await rewriteQuery(
        this.gateway,
        opts.history ?? [],
        query,
        undefined,
        undefined,
        this.timeZone,
      ));
    const searchQuery = rewrite.query;
    const entityCandidates = [
      ...new Set([...rewrite.entities, ...queryEntityCandidates(searchQuery)]),
    ];

    // 2. Open-loops mode (memory-backed since): the day-one question's second half, straight from the gated
    // memory read — the facts ARE the open loops, so every line the answerer
    // writes cites the fact it rests on.
    if (rewrite.openLoops) {
      const openLoops = await this.openLoops(principal, rewrite.openLoops.entity, opts);
      return {
        memories: openLoops.map(({ memory }) => ({
          memory,
          score: 0,
          signals: [],
          vectorScore: null,
        })),
        mode: 'open_loops',
        openLoops,
      };
    }

    // 3. Temporal mode: explicit intent only — the
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
    if (!opts.ambiguity) return { memories: results, mode: 'default' };

    // 6. The spec §7.5 ambiguity decision (V2.3 item 6.3): deterministic
    // arithmetic over the fused distribution, alias-aware clustering, no
    // model call. An unknown embedding model fails loudly here by design.
    const ambiguity = await this.decideAmbiguity(principal, results, entityCandidates, query);
    return { memories: results, mode: 'default', ambiguity };
  }

  /** Cluster the fused results by anchored subject and run the decision rule. */
  private async decideAmbiguity(
    principal: Principal,
    results: RetrievedMemory[],
    queryEntities: string[],
    queryText: string,
  ): Promise<AmbiguityDecisionDto> {
    const aliases = this.db
      ? await new EntityAliasStore(this.db).indexForOwner(
          principal.userId,
          // Aliases are space-scoped (docs/features/spaces.md): clustering in
          // one space must never fold names under another space's vocabulary.
          resolveSpaceId(principal),
        )
      : EMPTY_ALIAS_INDEX;
    const keyOf: EntityKeyOf = (name) => aliases.keyOf(name);
    const clusters = clusterBySubject(
      results.map((hit) => ({
        memoryId: hit.memory.id,
        subjectEntity: hit.memory.subjectEntity,
        entities: hit.memory.entities,
        content: hit.memory.content,
        fusedScore: hit.score,
        vectorScore: hit.vectorScore,
      })),
      keyOf,
      queryEntities,
    );
    const embeddingModel = this.gateway.embeddingModelId();
    // Thresholds are keyed by the GEOMETRY actually embedding; the decision
    // record below keeps the model's own (served) name.
    const thresholds = ambiguityThresholdsFor(this.gateway.embeddingGeometryId(), embeddingModel);
    return decideAmbiguity(clusters, queryEntities, keyOf, thresholds, {
      configVersion: AMBIGUITY_CONFIG_VERSION,
      embeddingModel,
      // The user's own words (issue #497): the rewrite's entity extraction
      // fails on follow-up phrasings, and the decision must still see the
      // subject the user just typed.
      queryText,
    });
  }

  /**
   * The open loops themselves: one gated memory read for the
   * standing commitments and open items, then ingestion's dormant flags
   * layered on. Public so the composition roots (attention, the skill
   * planner) assemble their "awaiting you" surfaces from exactly this query
   * rather than a second, drifting definition of "still open".
   */
  async openLoops(
    principal: Principal,
    entity: string | null = null,
    opts: RetrieveOptions = {},
  ): Promise<OpenLoop[]> {
    const rows = await this.memoryStore.openLoopsForPrincipal(principal, {
      entity: entity ?? undefined,
      includeSensitive: opts.includeSensitive,
      sourceRefs: opts.lens,
    });
    if (rows.length === 0) return [];
    const dormant = this.db
      ? new Set((await listOpenDormantFlags(this.db)).map((flag) => flag.memoryId))
      : new Set<string>();
    return rows.map((memory) => ({ memory, dormant: dormant.has(memory.id) }));
  }

  /**
   * Temporal retrieval: 'previous' is the standard fused
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
        sourceRefs: opts.lens,
      });
      return {
        memories: hits.map((hit) => ({
          memory: hit.memory,
          score: hit.score ?? 0,
          signals: hit.score !== null ? (['vector'] as RetrievalSignal[]) : [],
          vectorScore: hit.score,
        })),
        mode: 'temporal',
        temporal,
      };
    }

    const changes = await this.memoryStore.changesSince(principal, temporal.since!, {
      includeSensitive: opts.includeSensitive,
      limit: Math.max(opts.topK, 20),
      sourceRefs: opts.lens,
    });
    // The events' memories become the citable facts, deduplicated.
    const byId = new Map<string, MemoryRow>();
    for (const change of changes) byId.set(change.memory.id, change.memory);
    return {
      memories: [...byId.values()].map((memory) => ({
        memory,
        score: 0,
        signals: [],
        vectorScore: null,
      })),
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
      // The lens rides every signal (V2.5 item 8.3): narrowing one arm and
      // not the others would let an out-of-project fact back in through the
      // widest one.
      sourceRefs: opts.lens,
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
            // The widen arm predates the lens and used to drop it, which was
            // the one arm the contract above did not cover: an out-of-project
            // fact could re-enter through exactly the widest signal and even
            // found a fan-out cluster. The lens rides EVERY arm.
            sourceRefs: opts.lens,
          })
        : Promise.resolve([]),
    ]);

    const rowsById = new Map<string, MemoryRow>();
    for (const { memory } of [...ftsHits, ...entityHits, ...widenHits])
      rowsById.set(memory.id, memory);
    const unresolved = vectorHits.map((h) => h.memoryId).filter((id) => !rowsById.has(id));
    // The lens applies here too, and EXACTLY: the Qdrant pre-filter narrows on
    // `source_id` alone and is skipped above its cap, so this resolution is
    // the belt on the full (type, id) pair. An id it drops never resolves,
    // and `fuseAndRank` already excludes what it cannot resolve.
    for (const row of await this.memoryStore.getManyForPrincipal(principal, unresolved, {
      ...opts,
      sourceRefs: opts.lens,
    })) {
      rowsById.set(row.id, row);
    }

    const lists: RankedList[] = [
      { signal: 'vector', ids: vectorHits.map((h) => h.memoryId) },
      { signal: 'fts', ids: ftsHits.map((h) => h.memory.id) },
      { signal: 'entity', ids: [...entityHits, ...widenHits].map((h) => h.memory.id) },
    ];
    // The one score with absolute meaning rides along for the ambiguity
    // relevance floor (V2.3 item 6.3); the fused rank order is untouched.
    const vectorScoreById = new Map(vectorHits.map((h) => [h.memoryId, h.score]));
    // Widening lets the answer aggregate more than the default slice.
    const limit = extra?.widenEntity ? Math.max(topK, PROFILE_CEILING) : topK;
    return fuseAndRank(lists, (id) => rowsById.get(id)?.status, extra?.multipliers)
      .slice(0, limit)
      .map((hit) => ({
        memory: rowsById.get(hit.memoryId)!,
        score: hit.score,
        signals: hit.signals,
        vectorScore: vectorScoreById.get(hit.memoryId) ?? null,
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
    const searchOpts = {
      topK: PROFILE_CEILING,
      includeSensitive: opts.includeSensitive,
      sourceRefs: opts.lens,
    };
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
    for (const row of await this.memoryStore.getManyForPrincipal(principal, vectorIds, {
      ...opts,
      sourceRefs: opts.lens,
    })) {
      if (mentionsEntity(row, focus)) {
        rowsById.set(row.id, row);
        note(row.id, 'vector');
      }
    }

    const vectorScoreById = new Map(vectorHits.map((h) => [h.memoryId, h.score]));
    return [...rowsById.values()]
      .filter((row) => row.status !== 'replaced') // replaced ×0 — excluded (spec §3.4)
      .sort(byStatusThenRecency)
      .map((memory) => ({
        memory,
        score: 0,
        signals: [...(signalsById.get(memory.id) ?? [])],
        vectorScore: vectorScoreById.get(memory.id) ?? null,
      }));
  }
}
