import { sql } from 'drizzle-orm';
import type { Db, Tx } from '../infrastructure/index';
import { embeddingIndexState } from './persistence/tables';
import type { EmbeddingIndexStateRow } from './persistence/tables';
import { dimensionsFor, MEMORY_COLLECTION } from './persistence/vector-store';

/**
 * The vector index's durable state (V2.4 item 7.1 second half, migration
 * 0053): which Qdrant collection is ACTIVE and at what dimension, plus the
 * managed rebuild when one is live. One row; owned by memory like everything
 * else about the index.
 *
 * Why a state row at all: before 0053 the collection name was a constant and
 * the expected dimension a code registry, so the only way to change the
 * embeddings model was to edit configuration and let the boot guard refuse to
 * start until an operator reran the index by hand. With the collection and its
 * dimension recorded as data, a rebuild can construct a NEW collection beside
 * the serving one and switch atomically at completion, and an arbitrary
 * self-hosted model carries its PROBED dimension instead of a registry guess.
 */

/** Prefix of every rebuild target collection — the integrity sweep recognises
 * strays by it after a crash. */
export const REBUILD_COLLECTION_PREFIX = 'memories_r';

export type EmbeddingRebuildPhase = 'embedding' | 'finalizing';

/** The rebuild as surfaces show it: the Models page, capabilities, health. */
export interface EmbeddingRebuildStatus {
  status: 'running' | 'failed';
  phase: EmbeddingRebuildPhase;
  targetProviderLabel: string | null;
  targetModel: string;
  factsDone: number;
  factsTotal: number;
  /** The same chars/4 accounting the budget meter charges, accumulated. */
  tokensSpent: number;
  startedAt: string | null;
  /** Rate-based estimate; null until enough progress exists to compute one. */
  estimatedSecondsRemaining: number | null;
  /** Set while failed, and while paused on an exhausted budget. */
  error: string | null;
  cancelRequested: boolean;
}

export async function readEmbeddingIndexState(db: Db | Tx): Promise<EmbeddingIndexStateRow> {
  const rows = await db.select().from(embeddingIndexState).limit(1);
  const row = rows[0];
  if (!row) {
    // Migration 0053 inserts the singleton; an empty table means migrations
    // did not run, and pretending a default would hide that.
    throw new Error('embedding_index_state is empty: did migrations run?');
  }
  return row;
}

/** Lock the singleton row for the duration of the caller's transaction — the
 * begin/cancel/advance mutual exclusion beyond the job's single-flight. */
export async function readEmbeddingIndexStateForUpdate(tx: Tx): Promise<EmbeddingIndexStateRow> {
  const rows = await tx.select().from(embeddingIndexState).for('update');
  const row = rows[0];
  if (!row) throw new Error('embedding_index_state is empty: did migrations run?');
  return row;
}

export async function updateEmbeddingIndexState(
  db: Db | Tx,
  patch: Partial<typeof embeddingIndexState.$inferInsert>,
): Promise<void> {
  await db.update(embeddingIndexState).set({ ...patch, updatedAt: new Date() });
}

/**
 * The active collection and its dimension, resolved: a pre-0053 row carries no
 * recorded dimension, so the model registry answers, exactly as it did before
 * the state existed.
 */
export function resolveActiveIndex(
  row: EmbeddingIndexStateRow,
  activeModel: string,
): { collection: string; dimensions: number } {
  return {
    collection: row.activeCollection || MEMORY_COLLECTION,
    dimensions: row.activeDimensions ?? dimensionsFor(activeModel),
  };
}

/**
 * The rebuild status as the interface and the health report render it. A
 * plain function (the `pipelineStageFor` shape) so other modules read the
 * state without naming the table. Null when no rebuild exists.
 */
export async function embeddingRebuildStatus(db: Db): Promise<EmbeddingRebuildStatus | null> {
  const row = await readEmbeddingIndexState(db);
  return rebuildStatusOf(row);
}

export function rebuildStatusOf(row: EmbeddingIndexStateRow): EmbeddingRebuildStatus | null {
  if (!row.rebuildStatus || !row.targetModel) return null;
  const done = row.factsDone ?? 0;
  const total = row.factsTotal ?? 0;
  let estimatedSecondsRemaining: number | null = null;
  if (row.startedAt && done > 0 && total > done) {
    const elapsedSeconds = (Date.now() - row.startedAt.getTime()) / 1000;
    if (elapsedSeconds > 0) {
      estimatedSecondsRemaining = Math.round((total - done) * (elapsedSeconds / done));
    }
  }
  return {
    // 'switching' never persists (the switch is one transaction); 'running'
    // with a full count renders as finalizing.
    status: row.rebuildStatus === 'failed' ? 'failed' : 'running',
    phase: total > 0 && done >= total ? 'finalizing' : 'embedding',
    targetProviderLabel: row.targetProviderLabel,
    targetModel: row.targetModel,
    factsDone: done,
    factsTotal: total,
    tokensSpent: row.tokensSpent ?? 0,
    startedAt: row.startedAt?.toISOString() ?? null,
    estimatedSecondsRemaining,
    error: row.rebuildError,
    cancelRequested: row.cancelRequested,
  };
}

/**
 * The embedding-write lock (advisory, transaction-scoped).
 *
 * Everything that writes a MODEL-STAMPED vector — pipeline stage 5, the
 * memory.embed job — takes the SHARED side around "embed, stamp the row,
 * upsert the point", and the rebuild's final switch takes the EXCLUSIVE side
 * around "last catch-up, resync, stamp, flip". That one exclusion is what
 * makes the switch atomic against in-flight ingestion: without it, a fact
 * embedded under the old model could commit after the final catch-up scanned
 * past it, and the switched instance would hold a row the new index never
 * received.
 */
/**
 * The live-index binding a composition root threads into the vector store:
 * version-cached resolution of the active collection (flips exactly when the
 * model-configuration version does, so the query embedding and the collection
 * it searches flip together), and UNCACHED gate-sync targets (a rebuild
 * begins without a version bump, and a sensitive toggle must reach the
 * half-built collection from its first moment).
 */
export function liveIndexBinding(
  db: Db,
  providers: { version: number; tiers: { embedding: { model: string } } },
): {
  versionOf: () => number;
  read: () => Promise<{ collection: string; dimensions: number }>;
  gateSyncTargets: () => Promise<string[]>;
} {
  return {
    versionOf: () => providers.version,
    read: async () =>
      resolveActiveIndex(await readEmbeddingIndexState(db), providers.tiers.embedding.model),
    gateSyncTargets: async () => {
      const row = await readEmbeddingIndexState(db);
      const targets = [resolveActiveIndex(row, providers.tiers.embedding.model).collection];
      if (row.rebuildStatus === 'running' && row.targetCollection) {
        targets.push(row.targetCollection);
      }
      return targets;
    },
  };
}

const EMBEDDING_WRITE_LOCK = 'cogeto:embedding-index-write';

export async function acquireEmbeddingWriteLockShared(tx: Tx): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${EMBEDDING_WRITE_LOCK}, 0))`,
  );
}

export async function acquireEmbeddingWriteLockExclusive(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${EMBEDDING_WRITE_LOCK}, 0))`);
}
