import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  NotImplementedException,
  Optional,
} from '@nestjs/common';
import { and, desc, eq, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { MemoryScope, MemoryStatus, Principal } from '@cogeto/shared';
import { DRIZZLE, writeAudit } from '../infrastructure/index';
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
  sensitive?: boolean;
  validFrom?: Date;
  validUntil?: Date;
  /** Ingestion stores unverified facts as `uncertain` (§B.3); default `active`. */
  initialStatus?: 'active' | 'uncertain';
  /** Which embed model produced (or is about to produce) this memory's vector. */
  embeddingModel?: string;
}

export interface ReadOptions {
  /** Ruling 3: explicit opt-in; even then, only the caller's own sensitive rows. */
  includeSensitive?: boolean;
}

export interface ListOptions extends ReadOptions {
  limit?: number;
  offset?: number;
}

export interface MemorySearchHit {
  memoryId: string;
  /** Normalized to [0,1], higher = better (research: memory-architecture §6). */
  score: number;
}

export interface SearchOptions extends ReadOptions {
  topK: number;
}

/** Deletion happens only through the saga (§A.7). Implementation: Session 4. */
export abstract class DeletionSaga {
  abstract requestDeletion(
    principal: Principal,
    source: { sourceType: SourceType; sourceId: string },
  ): Promise<{ receiptId: string }>;
}

@Injectable()
export class DeletionSagaStub extends DeletionSaga {
  requestDeletion(): Promise<{ receiptId: string }> {
    throw new NotImplementedException(
      'deletion saga arrives in Session 4 (§A.7); hard delete has no other path',
    );
  }
}

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
      .where(this.visibleTo(principal, opts))
      .orderBy(desc(memory.createdAt))
      .limit(Math.min(opts.limit ?? 50, 200))
      .offset(opts.offset ?? 0);
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
    return this.db.transaction(async (tx) => {
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
      return updated as MemoryRow;
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
    if (actor.kind !== 'user' && actor.kind !== 'reconciliation') {
      throw new BadRequestException('only the user or reconciliation may supersede a memory');
    }
    return this.db.transaction(async (tx) => {
      const old = await this.lockRow(tx, predecessorId, actor);
      if (old.status === 'replaced') {
        throw new BadRequestException('memory is already replaced; supersede its successor');
      }
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
        .where(eq(memory.id, predecessorId))
        .returning();
      await writeAudit(tx, {
        actor: actorLabel(actor),
        action: 'memory.superseded',
        entityType: 'memory',
        entityId: predecessorId,
        detail: { supersededBy: successor.id, validUntil: successorValidFrom.toISOString() },
      });
      return { predecessor: predecessor as MemoryRow, successor };
    });
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
    const hits = await this.requireVectors().search(
      embedding,
      buildGateFilter(principal, opts),
      opts.topK,
    );
    return hits.map((hit) => ({
      memoryId: hit.id,
      score: Math.min(1, Math.max(0, (hit.score + 1) / 2)),
    }));
  }

  fullTextSearch(
    _principal: Principal,
    _query: string,
    _opts: SearchOptions,
  ): Promise<MemorySearchHit[]> {
    throw new NotImplementedException('Session 3: Postgres FTS (§A.5)');
  }

  entitySearch(
    _principal: Principal,
    _entity: string,
    _opts: SearchOptions,
  ): Promise<MemorySearchHit[]> {
    throw new NotImplementedException('Session 3: trigram entity match (§A.5)');
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

  private requireVectors(): MemoryVectorStore {
    if (!this.vectors) {
      throw new NotImplementedException(
        'MemoryStore was constructed without a vector store (Qdrant) — register MemoryModule with a qdrantUrl',
      );
    }
    return this.vectors;
  }

  // ── Private: the gates and shared write paths ───────────────────────────────

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
