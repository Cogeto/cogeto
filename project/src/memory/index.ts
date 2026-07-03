/** Public interface of the memory bounded context (§A.1 rule 1). */
export { MemoryModule } from './memory.module';
export type { MemoryModuleOptions } from './memory.module';
export { MemoryStore, DeletionSaga, MEMORY_EMBED_JOB_TYPE } from './memory.store';
export { createMemoryStore } from './factory';
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
export { checkTransition, actorLabel } from './domain/transition';
export type { MemoryActor, ActorKind, TransitionCheck } from './domain/transition';
export type { MemoryRow, SourceType } from './persistence/tables';
// Reindex: rebuild Qdrant from Postgres (§A.4). Qdrant stays module-private —
// callers pass primitives and a gateway, never a client.
export { reindexMemories } from './reindex';
export type { ReindexOptions, ReindexReport } from './reindex';
