import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  NotImplementedException,
  Optional,
} from '@nestjs/common';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { FactKind, MemoryScope, MemoryStatus, Principal } from '@cogeto/shared';
import { DRIZZLE, withTransactionalEnqueue, writeAudit } from '../infrastructure/index';
import type { Db, Tx } from '../infrastructure/index';
import { memory } from './persistence/tables';
import type { MemoryRow, SourceType } from './persistence/tables';
import { buildGateFilter, MemoryVectorStore } from './persistence/vector-store';
import type { MemoryPoint } from './persistence/vector-store';
import { actorLabel, checkTransition } from './domain/transition';
import type { MemoryActor } from './domain/transition';

/**
 * Public interface of the memory module (§A.1 rule 1; decision 0003 ruling 2).
 *
 * Every read REQUIRES a Principal and applies the scope and sensitive gates
 * inside the query builder — an unscoped read is unrepresentable through this
 * interface. Raw table access stays private to this module.
 *
 * Gates (hard, never score factors — §A.5 as amended by 0003 ruling 3):
 * - scope:     own rows, or rows with scope 'shared'.
 * - sensitive: excluded by default; returned ONLY to the owner, ONLY on
 *   explicit per-query opt-in.
 */

export interface NewFact {
  content: string;
  scope: MemoryScope;
  sourceType: SourceType;
  sourceId: string;
  /** Extracted entity names, flat (decision 0006 ruling 2) — the §A.5 entity signal. */
  entities?: string[];
  /** The entity this fact is primarily ABOUT (F1/F4) — distinct from mentions. */
  subjectEntity?: string;
  /** The extractor's fact kind (migration 0011) — reconciliation matches on it. */
  kind?: FactKind;
  /** Raw temporal phrases code could not resolve (decision 0007 ruling 1). */
  temporalUnresolved?: string[];
  sensitive?: boolean;
  validFrom?: Date;
  validUntil?: Date;
  /**
   * Ingestion stores unverified facts as `uncertain` (§B.3); default `active`.
   * `user_approved` exists for edit-supersession successors only (0006 ruling 3).
   */
  initialStatus?: 'active' | 'uncertain' | 'user_approved';
  /** Which embed model produced (or is about to produce) this memory's vector. */
  embeddingModel?: string;
}

export interface ReadOptions {
  /** Ruling 3: explicit opt-in; even then, only the caller's own sensitive rows. */
  includeSensitive?: boolean;
}

/** Dashboard filters (S3-B) — WHERE clauses, composed with the gates, never after them. */
export interface MemoryFilters {
  scope?: MemoryScope;
  status?: MemoryStatus;
  /** Only sensitive rows. Effective only with the includeSensitive opt-in. */
  sensitiveOnly?: boolean;
  /** Trigram-matched against the stored entities array. */
  entity?: string;
}

export interface ListOptions extends ReadOptions, MemoryFilters {
  limit?: number;
  offset?: number;
}

export interface MemorySearchHit {
  memoryId: string;
  /** Normalized to [0,1], higher = better (research: memory-architecture §6). */
  score: number;
}

/** FTS and entity hits carry the row itself — the SQL already read it, gated. */
export interface ScoredMemory {
  memory: MemoryRow;
  /** Normalized to [0,1], higher = better. */
  score: number;
}

export interface SearchOptions extends ReadOptions {
  topK: number;
  /**
   * Reconciliation candidate narrowing (decision 0010 ruling 6) — additive
   * pre-filters ON TOP of the gates, inside the vector query, never after it:
   * exact scope, own rows only (drops the shared-scope arm of the gate), and
   * a status allowlist. Retrieval callers pass none of these.
   */
  scope?: MemoryScope;
  ownerOnly?: boolean;
  statuses?: MemoryStatus[];
}

/** ftsSearch/entitySearch accept the dashboard filters; vectorSearch does not (retrieval-only). */
export type FilteredSearchOptions = SearchOptions & MemoryFilters;

/** The job the edit path enqueues: embed the supersession successor (worker). */
export const MEMORY_EMBED_JOB_TYPE = 'memory.embed';

@Injectable()
export class MemoryStore {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    /** Optional so pure-Postgres tests need no Qdrant; DI always provides it. */
    @Optional() private readonly vectors?: MemoryVectorStore,
  ) {}

  // ── Reads (Principal-gated) ─────────────────────────────────────────────────

  async getForPrincipal(
    principal: Principal,
    memoryId: string,
    opts: ReadOptions = {},
  ): Promise<MemoryRow | null> {
    const rows = await this.db
      .select()
      .from(memory)
      .where(and(eq(memory.id, memoryId), this.visibleTo(principal, opts)))
      .limit(1);
    return rows[0] ?? null;
  }

  async listForPrincipal(principal: Principal, opts: ListOptions = {}): Promise<MemoryRow[]> {
    return this.db
      .select()
      .from(memory)
      .where(and(this.visibleTo(principal, opts), ...this.filterClauses(opts)))
      .orderBy(desc(memory.createdAt), memory.id)
      .limit(Math.min(opts.limit ?? 50, 200))
      .offset(opts.offset ?? 0);
  }

  /** Total under the same gates + filters — the list's pagination and the review badge. */
  async countForPrincipal(
    principal: Principal,
    opts: ReadOptions & MemoryFilters = {},
  ): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(memory)
      .where(and(this.visibleTo(principal, opts), ...this.filterClauses(opts)));
    return rows[0]?.n ?? 0;
  }

  /**
   * The supersession chain through a memory, oldest → newest (§B.2, S3-B
   * history panel): follows superseded_by forward and its inverse backward.
   * Every hop passes the same gates as any read.
   */
  async getChain(
    principal: Principal,
    memoryId: string,
    opts: ReadOptions = {},
  ): Promise<MemoryRow[]> {
    const target = await this.getForPrincipal(principal, memoryId, opts);
    if (!target) return [];
    const chain: MemoryRow[] = [target];

    // Backward: who was replaced by the head of the chain?
    for (let hops = 0; hops < 50; hops += 1) {
      const head = chain[0]!;
      const rows = await this.db
        .select()
        .from(memory)
        .where(and(eq(memory.supersededBy, head.id), this.visibleTo(principal, opts)))
        .limit(1);
      if (!rows[0]) break;
      chain.unshift(rows[0]);
    }
    // Forward: what replaced the tail?
    for (let hops = 0; hops < 50; hops += 1) {
      const tail = chain[chain.length - 1]!;
      if (!tail.supersededBy) break;
      const next = await this.getForPrincipal(principal, tail.supersededBy, opts);
      if (!next) break;
      chain.push(next);
    }
    return chain;
  }

  // ── Writes (aggregate-owned invariants) ────────────────────────────────────

  async createFromFact(principal: Principal, fact: NewFact): Promise<MemoryRow> {
    return this.db.transaction(async (tx) =>
      this.insertFact(tx, principal.userId, fact, `user:${principal.userId}`),
    );
  }

  /**
   * Admission path for the ingestion pipeline (§B.3): the verification pass
   * decides `initialStatus` (supported → active, partial/unsupported →
   * uncertain) and admits the fact inside the pipeline job's transaction, so
   * admission and the job's idempotency row commit atomically.
   */
  async admitExtractedFact(tx: Tx, ownerId: string, fact: NewFact): Promise<MemoryRow> {
    return this.insertFact(tx, ownerId, fact, 'verification');
  }

  /**
   * The single status-transition path. Legality is decided by the pure
   * checkTransition function; every transition writes an audit row in the
   * same transaction.
   */
  async transition(
    actor: MemoryActor,
    memoryId: string,
    to: MemoryStatus,
    reason?: string,
  ): Promise<MemoryRow> {
    return this.db.transaction(async (tx) => this.transitionInTx(tx, actor, memoryId, to, reason));
  }

  /**
   * The transition body, composable into a caller's transaction — how
   * reconciliation (pipeline stage 6, the contradiction resolutions) makes
   * status changes commit atomically with the relation rows and, in stage 6,
   * with the not-yet-committed incoming facts (decision 0010 ruling 1).
   */
  async transitionInTx(
    tx: Tx,
    actor: MemoryActor,
    memoryId: string,
    to: MemoryStatus,
    reason?: string,
  ): Promise<MemoryRow> {
    const row = await this.lockRow(tx, memoryId, actor);
    const check = checkTransition(row.status, to, actor);
    if (!check.allowed) {
      throw new BadRequestException(`illegal transition ${row.status} -> ${to}: ${check.reason}`);
    }
    const [updated] = await tx
      .update(memory)
      .set({ status: to, updatedAt: new Date() })
      .where(eq(memory.id, memoryId))
      .returning();
    await writeAudit(tx, {
      actor: actorLabel(actor),
      action: 'memory.status_transition',
      entityType: 'memory',
      entityId: memoryId,
      detail: { from: row.status, to, reason: reason ?? null },
    });
    // Keep the Qdrant payload copy honest (§A.4), point op last: a failure
    // rolls the row back and the caller retries — the two stores converge.
    await this.vectors?.setPayload(memoryId, { status: to });
    return updated as MemoryRow;
  }

  /**
   * Sensitive is a hard gate (0003 ruling 3) — its payload copy in Qdrant must
   * change in the same act as the row. Two-store pattern (S2-B): row update +
   * audit in the transaction, the point payload write last; a failed payload
   * write rolls everything back and a retry converges (setPayload is
   * idempotent; a not-yet-embedded memory has no point and that is a no-op).
   */
  async toggleSensitive(
    principal: Principal,
    memoryId: string,
    sensitive: boolean,
  ): Promise<MemoryRow> {
    const actor: MemoryActor = { kind: 'user', userId: principal.userId };
    return this.db.transaction(async (tx) => {
      const row = await this.lockRow(tx, memoryId, actor);
      if (row.sensitive === sensitive) return row; // idempotent no-op, no audit noise
      const [updated] = await tx
        .update(memory)
        .set({ sensitive, updatedAt: new Date() })
        .where(eq(memory.id, memoryId))
        .returning();
      await writeAudit(tx, {
        actor: actorLabel(actor),
        action: 'memory.sensitive_toggled',
        entityType: 'memory',
        entityId: memoryId,
        detail: { sensitive },
      });
      await this.requireVectors().setPayload(memoryId, { sensitive });
      return updated as MemoryRow;
    });
  }

  /**
   * Editing content is supersession, never mutation (0006 ruling 3): one
   * transaction creates the successor (`user_approved`, same provenance),
   * marks the predecessor `replaced`, writes the edit audit entry, and
   * enqueues the successor's embedding job via the outbox — the fast path
   * never calls the embed model. Until the worker embeds it, the successor is
   * findable via FTS/entity; vector search catches up within seconds.
   */
  async editContent(
    principal: Principal,
    memoryId: string,
    newContent: string,
  ): Promise<{ predecessor: MemoryRow; successor: MemoryRow }> {
    return this.db.transaction(async (tx) =>
      this.editContentInTx(tx, principal, memoryId, newContent),
    );
  }

  /**
   * The edit body, composable into a caller's transaction — the "correct both"
   * contradiction resolution (0010 ruling 3) performs two edits and resolves
   * the relation atomically through this.
   */
  async editContentInTx(
    tx: Tx,
    principal: Principal,
    memoryId: string,
    newContent: string,
  ): Promise<{ predecessor: MemoryRow; successor: MemoryRow }> {
    const actor: MemoryActor = { kind: 'user', userId: principal.userId };
    const old = await this.lockRow(tx, memoryId, actor);
    if (old.status === 'replaced') {
      throw new BadRequestException('memory is already replaced; edit its successor instead');
    }
    const result = await this.supersedeCore(tx, actor, old, {
      content: newContent,
      scope: old.scope,
      sourceType: old.sourceType,
      sourceId: old.sourceId,
      entities: old.entities,
      subjectEntity: old.subjectEntity ?? undefined,
      kind: old.kind ?? undefined,
      sensitive: old.sensitive,
      validUntil: old.validUntil ?? undefined,
      initialStatus: 'user_approved',
    });
    await writeAudit(tx, {
      actor: actorLabel(actor),
      action: 'memory.edited',
      entityType: 'memory',
      entityId: memoryId,
      detail: { successor: result.successor.id },
    });
    await withTransactionalEnqueue(
      tx,
      {
        type: 'memory.edited',
        payload: { memory_id: memoryId, successor_id: result.successor.id },
      },
      {
        type: MEMORY_EMBED_JOB_TYPE,
        payload: { source_type: 'memory', source_id: result.successor.id },
      },
    );
    return result;
  }

  /**
   * Review rejection (0006 ruling 4): an audited removal of the row and its
   * Qdrant point through this guarded path — the narrow extension of "only
   * the saga hard-deletes". Legal ONLY from `uncertain`; owner-only. Ordering
   * makes it converge: the point is deleted before the row-delete commits, so
   * a failed point delete rolls the row back and the retry repeats both.
   * Returns null when the memory does not exist (already rejected — done).
   */
  async rejectUncertain(principal: Principal, memoryId: string): Promise<MemoryRow | null> {
    const actor: MemoryActor = { kind: 'user', userId: principal.userId };
    return this.db.transaction(async (tx) => {
      const rows = await tx.select().from(memory).where(eq(memory.id, memoryId)).for('update');
      const row = rows[0];
      if (!row) return null;
      if (actor.kind === 'user' && row.ownerId !== actor.userId) {
        throw new NotFoundException(`memory ${memoryId} not found`);
      }
      if (row.status !== 'uncertain') {
        throw new BadRequestException(
          `only an uncertain memory can be rejected in review (this one is ${row.status}); ` +
            'source-level deletion goes through the deletion saga (§A.7)',
        );
      }
      await tx.delete(memory).where(eq(memory.id, memoryId));
      await writeAudit(tx, {
        actor: actorLabel(actor),
        action: 'memory.rejected',
        entityType: 'memory',
        entityId: memoryId,
        detail: { sourceType: row.sourceType, sourceId: row.sourceId, status: row.status },
      });
      await this.requireVectors().deletePoints([memoryId]);
      return row;
    });
  }

  /**
   * Supersession (§B.2): the ONLY path to `replaced`. Creates the successor,
   * closes the predecessor's validity interval, points superseded_by at the
   * successor — never deletes history.
   */
  async supersede(
    actor: MemoryActor,
    predecessorId: string,
    successorFact: NewFact,
  ): Promise<{ predecessor: MemoryRow; successor: MemoryRow }> {
    return this.db.transaction(async (tx) =>
      this.supersedeInTx(tx, actor, predecessorId, successorFact),
    );
  }

  /**
   * The supersession body, composable into a caller's transaction — how the
   * reconciliation merge enriches a survivor atomically with the merge itself
   * (decision 0010 ruling 4).
   */
  async supersedeInTx(
    tx: Tx,
    actor: MemoryActor,
    predecessorId: string,
    successorFact: NewFact,
  ): Promise<{ predecessor: MemoryRow; successor: MemoryRow }> {
    if (actor.kind !== 'user' && actor.kind !== 'reconciliation') {
      throw new BadRequestException('only the user or reconciliation may supersede a memory');
    }
    const old = await this.lockRow(tx, predecessorId, actor);
    if (old.status === 'replaced') {
      throw new BadRequestException('memory is already replaced; supersede its successor');
    }
    return this.supersedeCore(tx, actor, old, successorFact);
  }

  /** Shared body of supersede/editContent: caller holds the lock and the tx. */
  private async supersedeCore(
    tx: Tx,
    actor: MemoryActor,
    old: MemoryRow,
    successorFact: NewFact,
  ): Promise<{ predecessor: MemoryRow; successor: MemoryRow }> {
    const successorValidFrom = successorFact.validFrom ?? new Date();
    const successor = await this.insertFact(
      tx,
      old.ownerId,
      { ...successorFact, validFrom: successorValidFrom },
      actorLabel(actor),
    );
    const [predecessor] = await tx
      .update(memory)
      .set({
        status: 'replaced',
        validUntil: successorValidFrom,
        supersededBy: successor.id,
        updatedAt: new Date(),
      })
      .where(eq(memory.id, old.id))
      .returning();
    await writeAudit(tx, {
      actor: actorLabel(actor),
      action: 'memory.superseded',
      entityType: 'memory',
      entityId: old.id,
      detail: { supersededBy: successor.id, validUntil: successorValidFrom.toISOString() },
    });
    // Payload copy honesty (§A.4): the predecessor's point now says replaced.
    await this.vectors?.setPayload(old.id, { status: 'replaced' });
    return { predecessor: predecessor as MemoryRow, successor };
  }

  // ── Search primitives (0003 ruling 2: Principal-gated, gates in the store) ──

  /**
   * Semantic search over the Qdrant index. The scope and sensitive gates are
   * native payload pre-filters INSIDE the vector query (§A.4/§A.5) — an
   * ungated hit cannot exist, not even transiently. Scores are normalized to
   * [0,1], higher = better (cosine similarity mapped from [-1,1]).
   */
  async vectorSearch(
    principal: Principal,
    embedding: number[],
    opts: SearchOptions,
  ): Promise<MemorySearchHit[]> {
    const filter = buildGateFilter(principal, opts);
    // Candidate narrowing (0010 ruling 6): extra must-conditions AND with the
    // gates — they can only shrink the result, never widen past a gate.
    if (opts.scope) filter.must.push({ key: 'scope', match: { value: opts.scope } });
    if (opts.ownerOnly) filter.must.push({ key: 'owner_id', match: { value: principal.userId } });
    if (opts.statuses?.length) {
      filter.must.push({ key: 'status', match: { any: [...opts.statuses] } });
    }
    const hits = await this.requireVectors().search(embedding, filter, opts.topK);
    return hits.map((hit) => ({
      memoryId: hit.id,
      score: Math.min(1, Math.max(0, (hit.score + 1) / 2)),
    }));
  }

  /**
   * Keyword full-text search over the generated content_tsv column (migration
   * 0005; decision 0006 ruling 1: simple config + unaccent). The scope and
   * sensitive gates are WHERE clauses in the same query — no post-filtering.
   * Scores are ts_rank_cd with normalization 32 (rank/(rank+1)), i.e. [0,1).
   */
  async ftsSearch(
    principal: Principal,
    query: string,
    opts: FilteredSearchOptions,
  ): Promise<ScoredMemory[]> {
    if (!query.trim()) return [];
    const tsQuery = sql`websearch_to_tsquery('simple', cogeto_unaccent(${query}))`;
    const score = sql<number>`ts_rank_cd(content_tsv, ${tsQuery}, 32)`;
    const rows = await this.db
      .select({ memory, score })
      .from(memory)
      .where(
        and(
          this.visibleTo(principal, opts),
          sql`content_tsv @@ ${tsQuery}`,
          ...this.filterClauses(opts),
        ),
      )
      .orderBy(desc(score), memory.id)
      .limit(opts.topK);
    return rows.map((row) => ({ memory: row.memory, score: Number(row.score) }));
  }

  /**
   * Trigram entity match (decision 0006 ruling 2): query names against the
   * entities array, fuzzy via pg_trgm's % operator (its similarity threshold),
   * gated exactly like every other read. Score = best similarity between any
   * stored entity and any queried name, already in [0,1].
   */
  async entitySearch(
    principal: Principal,
    names: string[],
    opts: FilteredSearchOptions,
  ): Promise<ScoredMemory[]> {
    const wanted = [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0))];
    if (wanted.length === 0) return [];
    const namesArray = sql`ARRAY[${sql.join(
      wanted.map((name) => sql`${name}`),
      sql`, `,
    )}]::text[]`;
    const score = sql<number>`(
      SELECT max(similarity(hit.entity, wanted.name))
      FROM unnest(entities) AS hit(entity), unnest(${namesArray}) AS wanted(name)
    )`;
    const rows = await this.db
      .select({ memory, score })
      .from(memory)
      .where(
        and(
          this.visibleTo(principal, opts),
          sql`EXISTS (
            SELECT 1 FROM unnest(entities) AS hit(entity), unnest(${namesArray}) AS wanted(name)
            WHERE hit.entity % wanted.name
          )`,
          ...this.filterClauses(opts),
        ),
      )
      .orderBy(desc(score), memory.id)
      .limit(opts.topK);
    return rows.map((row) => ({ memory: row.memory, score: Number(row.score) }));
  }

  /**
   * Gated batch read — how retrieval resolves vectorSearch's id hits into rows.
   * Same gates as every read; ids the principal may not see simply drop out.
   */
  async getManyForPrincipal(
    principal: Principal,
    memoryIds: string[],
    opts: ReadOptions = {},
  ): Promise<MemoryRow[]> {
    if (memoryIds.length === 0) return [];
    return this.db
      .select()
      .from(memory)
      .where(and(inArray(memory.id, memoryIds), this.visibleTo(principal, opts)));
  }

  // ── Vector index maintenance (memory owns the Qdrant client — ruling 2) ────

  /** Idempotent collection + payload-index creation; runs on worker boot. */
  async ensureIndexReady(): Promise<void> {
    await this.requireVectors().ensureCollection();
  }

  /**
   * Writes the Qdrant points for already-committed (or about-to-commit) rows.
   * Point id = memory id, so retries upsert instead of duplicating; callers
   * (pipeline stage 5, reindex) order this AFTER the Postgres writes.
   */
  async upsertVectors(rows: MemoryRow[], embeddings: number[][]): Promise<void> {
    if (rows.length !== embeddings.length) {
      throw new BadRequestException(
        `got ${embeddings.length} embeddings for ${rows.length} memories`,
      );
    }
    const points: MemoryPoint[] = rows.map((row, i) => ({
      id: row.id,
      vector: embeddings[i]!,
      payload: {
        owner_id: row.ownerId,
        scope: row.scope,
        status: row.status,
        sensitive: row.sensitive,
        source_type: row.sourceType,
        source_id: row.sourceId,
        valid_until: row.validUntil?.toISOString() ?? null,
      },
    }));
    await this.requireVectors().upsert(points);
  }

  /**
   * Stored embeddings by memory id — how the dreaming batch driver rebuilds
   * ReconcileInputs without re-embedding (decision 0011). Ids the caller
   * holds already passed a gated read; rows never embedded simply drop out.
   */
  async retrieveEmbeddings(memoryIds: string[]): Promise<Map<string, number[]>> {
    if (memoryIds.length === 0) return new Map();
    return this.requireVectors().retrieveVectors(memoryIds);
  }

  // ── System reads for the dreaming driver (decision 0011) ───────────────────
  // Worker-only machine reads, the out-of-module mirror of the sweep's
  // in-module scans: no Principal because the caller is the nightly job
  // covering every owner. They feed reconciliation, whose candidate reads and
  // actions re-apply the per-owner gates; nothing here reaches a user.

  /** The day's scope: rows admitted or touched inside the watermark window. */
  async listTouchedBetween(from: Date, to: Date, limit = 2000): Promise<MemoryRow[]> {
    return this.db
      .select()
      .from(memory)
      .where(
        and(
          inArray(memory.status, ['active', 'uncertain']),
          or(
            and(sql`${memory.createdAt} >= ${from}`, sql`${memory.createdAt} < ${to}`),
            and(sql`${memory.updatedAt} >= ${from}`, sql`${memory.updatedAt} < ${to}`),
          ),
        ),
      )
      .orderBy(memory.ownerId, memory.createdAt)
      .limit(limit);
  }

  /** Staleness pass input: active rows whose validity interval has lapsed. */
  async listLapsedActive(asOf: Date, limit = 2000): Promise<MemoryRow[]> {
    return this.db
      .select()
      .from(memory)
      .where(and(eq(memory.status, 'active'), sql`${memory.validUntil} < ${asOf}`))
      .orderBy(memory.createdAt)
      .limit(limit);
  }

  /** Dormant pass input: active commitments with no activity since the window. */
  async listQuietCommitments(quietBefore: Date, limit = 2000): Promise<MemoryRow[]> {
    return this.db
      .select()
      .from(memory)
      .where(
        and(
          eq(memory.status, 'active'),
          eq(memory.kind, 'commitment'),
          sql`${memory.createdAt} < ${quietBefore}`,
          sql`${memory.updatedAt} < ${quietBefore}`,
        ),
      )
      .orderBy(memory.createdAt)
      .limit(limit);
  }

  /** Batch system read — flag maintenance resolves current statuses through it. */
  async getManySystem(memoryIds: string[]): Promise<MemoryRow[]> {
    if (memoryIds.length === 0) return [];
    return this.db.select().from(memory).where(inArray(memory.id, memoryIds));
  }

  private requireVectors(): MemoryVectorStore {
    if (!this.vectors) {
      throw new NotImplementedException(
        'MemoryStore was constructed without a vector store (Qdrant) — register MemoryModule with a qdrantUrl',
      );
    }
    return this.vectors;
  }

  // ── Private: the gates and shared write paths ───────────────────────────────

  /** Dashboard filters as SQL — always ANDed with the gates, never a substitute. */
  private filterClauses(filters: MemoryFilters): SQL[] {
    const clauses: SQL[] = [];
    if (filters.scope) clauses.push(eq(memory.scope, filters.scope));
    if (filters.status) clauses.push(eq(memory.status, filters.status));
    if (filters.sensitiveOnly) clauses.push(eq(memory.sensitive, true));
    if (filters.entity?.trim()) {
      clauses.push(
        sql`EXISTS (
          SELECT 1 FROM unnest(entities) AS hit(entity)
          WHERE hit.entity % ${filters.entity.trim()}
        )`,
      );
    }
    return clauses;
  }

  /** The scope + sensitive gates. Private: every public read builds on this. */
  private visibleTo(principal: Principal, opts: ReadOptions): SQL {
    const scopeGate = or(eq(memory.ownerId, principal.userId), eq(memory.scope, 'shared'))!;
    const sensitiveGate = opts.includeSensitive
      ? or(eq(memory.sensitive, false), eq(memory.ownerId, principal.userId))!
      : eq(memory.sensitive, false);
    return and(scopeGate, sensitiveGate)!;
  }

  private async insertFact(
    tx: Tx,
    ownerId: string,
    fact: NewFact,
    actor: string,
  ): Promise<MemoryRow> {
    // Provenance is NOT NULL, always (§A.6): the aggregate rejects orphans even
    // where the database could not (an empty string satisfies a NOT NULL column).
    if (!ownerId.trim() || !fact.sourceType || !fact.sourceId.trim()) {
      throw new BadRequestException(
        'a memory requires owner_id, source_type and source_id — no orphans, ever (§A.6)',
      );
    }
    const [row] = await tx
      .insert(memory)
      .values({
        ownerId,
        scope: fact.scope,
        sourceType: fact.sourceType,
        sourceId: fact.sourceId,
        status: fact.initialStatus ?? 'active',
        sensitive: fact.sensitive ?? false,
        entities: fact.entities ?? [],
        subjectEntity: fact.subjectEntity,
        kind: fact.kind,
        temporalUnresolved: fact.temporalUnresolved ?? [],
        validFrom: fact.validFrom ?? new Date(),
        validUntil: fact.validUntil,
        content: fact.content,
        embeddingModel: fact.embeddingModel,
      })
      .returning();
    const created = row as MemoryRow;
    await writeAudit(tx, {
      actor,
      action: 'memory.created',
      entityType: 'memory',
      entityId: created.id,
      detail: { sourceType: fact.sourceType, sourceId: fact.sourceId, scope: fact.scope },
    });
    return created;
  }

  /**
   * Locks the row for the write. User actors may only touch rows they own —
   * reported as NotFound so the API does not leak the existence of other
   * users' memories.
   */
  private async lockRow(tx: Tx, memoryId: string, actor: MemoryActor): Promise<MemoryRow> {
    const rows = await tx.select().from(memory).where(eq(memory.id, memoryId)).for('update');
    const row = rows[0];
    if (!row || (actor.kind === 'user' && row.ownerId !== actor.userId)) {
      throw new NotFoundException(`memory ${memoryId} not found`);
    }
    return row;
  }
}
