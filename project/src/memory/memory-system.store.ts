import { Inject, Injectable, NotImplementedException, Optional } from '@nestjs/common';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { memory } from './persistence/tables';
import type { MemoryRow, SourceType } from './persistence/tables';
import { MemoryVectorStore } from './persistence/vector-store';

/**
 * The unscoped machine-read surface, as its own construction (V2.0 item 3.7).
 *
 * These reads take no Principal and apply no scope or sensitive gate, because
 * their caller is a worker job covering every owner: the nightly dreaming
 * cycle's batch driver and the skill runtime's step reads. They feed
 * reconciliation, whose candidate reads and actions re-apply the per-owner
 * gates; nothing here reaches a user.
 *
 * They used to sit on {@link MemoryStore}, where a section comment saying
 * "worker-only machine reads" was the entire enforcement, on a class every
 * request-path module injects. A convention is not a boundary: one of them was
 * in fact being called from a request path (`/api/research/runs/:id/progress`,
 * for a fact count that is now an owner-gated count on `MemoryStore`).
 *
 * **This class is only provided when a composition root registers the memory
 * module with `systemReads: true`, which only the worker root does.** In the
 * app process the provider does not exist at all, so a request-path service
 * cannot inject it: a controller or service that tried would fail to resolve
 * at boot rather than quietly read across every owner at runtime. Asserted by
 * `memory/system-store-worker-only.spec.ts`.
 *
 * Consumers that live in BOTH roots (the skill engine) receive it through their
 * named-options bag as an optional token and assert its presence on the paths
 * only the worker runs, so the app process never holds a reference to it.
 */
@Injectable()
export class MemorySystemStore {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Optional() private readonly vectors?: MemoryVectorStore,
  ) {}

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

  /** A source's derived memories — the skill runtime's gather input. */
  async listBySourceSystem(sourceType: SourceType, sourceId: string): Promise<MemoryRow[]> {
    return this.db
      .select()
      .from(memory)
      .where(and(eq(memory.sourceType, sourceType), eq(memory.sourceId, sourceId)))
      .orderBy(memory.createdAt, memory.id);
  }

  /**
   * Stored embeddings by memory id — how the dreaming batch driver rebuilds
   * ReconcileInputs without re-embedding. Ids the caller holds already passed a
   * gated read; rows never embedded simply drop out.
   */
  async retrieveEmbeddings(memoryIds: string[]): Promise<Map<string, number[]>> {
    if (memoryIds.length === 0) return new Map();
    if (!this.vectors) {
      throw new NotImplementedException(
        'MemorySystemStore was constructed without a vector store (Qdrant), register MemoryModule with a qdrantUrl',
      );
    }
    return this.vectors.retrieveVectors(memoryIds);
  }
}
