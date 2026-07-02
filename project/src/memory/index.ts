/** Public interface of the memory bounded context (§A.1 rule 1). */
export { MemoryModule } from './memory.module';
export { MemoryStore, DeletionSaga } from './memory.store';
export type {
  NewFact,
  ReadOptions,
  ListOptions,
  MemorySearchHit,
  SearchOptions,
} from './memory.store';
export { checkTransition, actorLabel } from './domain/transition';
export type { MemoryActor, ActorKind, TransitionCheck } from './domain/transition';
export type { MemoryRow, SourceType } from './persistence/tables';
