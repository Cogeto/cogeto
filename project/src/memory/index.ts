/** Public interface of the memory bounded context (spec §15 rule 1). */
export { MemoryModule } from './memory.module';
export { MemoryStore, MEMORY_EMBED_JOB_TYPE } from './memory.store';
/**
 * The unscoped machine-read surface (V2.0 item 3.7). Only resolvable where a
 * composition root registered the module with `systemReads: true`, which only
 * the worker root does; the app process has no such provider.
 */
export { MemorySystemStore } from './memory-system.store';
export {
  DeletionSaga,
  DeletionExecutor,
  DELETION_JOB_TYPE,
  SOURCE_DELETIONS,
  DERIVED_CASCADES,
  INGESTION_GUARD,
  INSTANCE_KEY_DIR,
} from './deletion-saga';
export type {
  SourceDeletion,
  SourceCascade,
  DerivedCascade,
  IngestionGuard,
  IngestionCancellation,
} from './deletion-saga';
export { parseReceiptCounts } from './deletion-saga';
export { verifyChain, canonicalize, GENESIS_HASH } from './domain/receipt-chain';
export type { ConfirmedReceipt } from './domain/receipt-chain';
export { IntegritySweep, SWEEP_JOB_TYPE, SWEEP_CRONTAB, SWEEP_OPTIONS } from './integrity-sweep';
export type { IntegrityStatus } from './integrity-sweep';
export { createIntegritySweep } from './factory';
export { MemoryObjectStore } from './persistence/object-store';
export { MemoryFileStore } from './file-store';
export { seedObjectFixture, seedOrphanPoint } from './dev-seed';
export { createMemoryStore, createMemorySystemStore, createMemoryReconciliation } from './factory';
export type { NewFact } from './memory.store';
export { runMemoryEmbedJob } from './embed-job';
export { MemoryReconciliation } from './reconciliation';
export type { PairActionResult } from './reconciliation';
export { chooseSurvivor, supersessionUnambiguous } from './domain/reconcile-policy';
export type { PolicyParty } from './domain/reconcile-policy';
/**
 * The interval predicate (AGENTS.md, spec §3): it exists ONCE, as a SQL
 * fragment and a pure TypeScript twin tested against each other, and no query,
 * view or answer-side check may hand-roll it. Exported even where no other
 * module uses it today, because the rule is only enforceable if the one
 * definition is the reachable one.
 */
export { intervalHoldsAt, intervalHoldsAtSql, isPastBelief } from './domain/interval';
/**
 * The scope + sensitive gate as one SQL expression (V2.0 item 3.7). Public
 * because the suppressed-fact log is gated by the SAME rule over its own table,
 * and two hand-written copies of a hard gate is two places to get it wrong.
 */
export { visibleToPrincipal } from './domain/scope-gate';
export type { MemoryChange } from './memory.store';
export type { MemoryRow, SourceType } from './persistence/tables';
// Reindex: rebuild Qdrant from Postgres (spec §4.2). Qdrant stays module-private —
// callers pass primitives and a gateway, never a client.
export { reindexMemories } from './reindex';
export { listForeignEmbeddingModels, vectorIndexDimensionMismatch } from './embedding-space';
