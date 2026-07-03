/** Public interface of the memory bounded context (§A.1 rule 1). */
export { MemoryModule } from './memory.module';
export type { MemoryModuleOptions } from './memory.module';
export { MemoryStore, DeletionSaga } from './memory.store';
export { createMemoryStore } from './factory';
export type { CreateMemoryStoreOptions } from './factory';
export type {
  NewFact,
  ReadOptions,
  ListOptions,
  MemorySearchHit,
  ScoredMemory,
  SearchOptions,
} from './memory.store';
export { checkTransition, actorLabel } from './domain/transition';
export type { MemoryActor, ActorKind, TransitionCheck } from './domain/transition';
export type { MemoryRow, SourceType } from './persistence/tables';
// Reindex: rebuild Qdrant from Postgres (§A.4). Qdrant stays module-private —
// callers pass primitives and a gateway, never a client.
export { reindexMemories } from './reindex';
export type { ReindexOptions, ReindexReport } from './reindex';
