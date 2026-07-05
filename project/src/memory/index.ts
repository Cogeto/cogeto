/** Public interface of the memory bounded context (§A.1 rule 1). */
export { MemoryModule } from './memory.module';
export type { MemoryModuleOptions } from './memory.module';
export { MemoryStore, MEMORY_EMBED_JOB_TYPE } from './memory.store';
export {
  DeletionSaga,
  DeletionExecutor,
  DELETION_JOB_TYPE,
  DELETION_JOB_SOURCE_TYPE,
  SOURCE_DELETIONS,
  DERIVED_CASCADES,
  INSTANCE_KEY_DIR,
} from './deletion-saga';
export type {
  SourceDeletion,
  DerivedCascade,
  DeletionPreview,
  ReceiptCounts,
} from './deletion-saga';
export { parseReceiptCounts } from './deletion-saga';
export { verifyChain, canonicalize, GENESIS_HASH } from './domain/receipt-chain';
export type { ChainVerification, ConfirmedReceipt } from './domain/receipt-chain';
export { IntegritySweep, SWEEP_JOB_TYPE, SWEEP_CRONTAB } from './integrity-sweep';
export type { SweepReport, IntegrityStatus, IntegrityAlertRecord } from './integrity-sweep';
export { createIntegritySweep } from './factory';
export type { CreateIntegritySweepOptions, QdrantOptions } from './factory';
export { MemoryObjectStore } from './persistence/object-store';
export type { ObjectStoreOptions } from './persistence/object-store';
export { seedObjectFixture, seedOrphanPoint } from './dev-seed';
export type { SeedObjectOptions, SeededObject, SeedOrphanOptions, SeededOrphan } from './dev-seed';
export { createMemoryStore, createMemoryReconciliation } from './factory';
export type { CreateMemoryStoreOptions } from './factory';
export type {
  NewFact,
  ReadOptions,
  ListOptions,
  MemoryFilters,
  MemorySearchHit,
  ScoredMemory,
  SearchOptions,
  FilteredSearchOptions,
} from './memory.store';
export { runMemoryEmbedJob } from './embed-job';
export { MemoryReconciliation } from './reconciliation';
export type {
  PairActionResult,
  ContradictionResolveAction,
  OpenContradiction,
} from './reconciliation';
export {
  chooseSurvivor,
  confirmLoserOutcome,
  eventTime,
  supersessionUnambiguous,
} from './domain/reconcile-policy';
export type { PolicyParty, MergeDecision } from './domain/reconcile-policy';
export { intervalHoldsAt, intervalHoldsAtSql, isPastBelief } from './domain/interval';
export type {
  PointInTimeOptions,
  PointInTimeHit,
  MemoryChange,
  MemoryChangeKind,
} from './memory.store';
export { checkTransition, actorLabel } from './domain/transition';
export type { MemoryActor, ActorKind, TransitionCheck } from './domain/transition';
export type { MemoryRow, MemoryRelationRow, SourceType } from './persistence/tables';
// Reindex: rebuild Qdrant from Postgres (§A.4). Qdrant stays module-private —
// callers pass primitives and a gateway, never a client.
export { reindexMemories } from './reindex';
export type { ReindexOptions, ReindexReport } from './reindex';
