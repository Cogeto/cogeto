import type { Db } from '../infrastructure/index';
import { MemoryStore } from './memory.store';
import { MemoryReconciliation } from './reconciliation';
import { MemoryVectorStore } from './persistence/vector-store';
import { MemoryObjectStore } from './persistence/object-store';
import type { ObjectStoreOptions } from './persistence/object-store';
import { IntegritySweep } from './integrity-sweep';
import type { SourceDeletion } from './deletion-saga';

/**
 * Composition helpers for non-Nest callers (entrypoint scripts, integration
 * tests in other modules). Take primitives only — the Qdrant and object-store
 * clients stay module-private (0003 ruling 2).
 */
export interface QdrantOptions {
  url: string;
  embeddingModel: string;
  /** Qdrant API key (QS-4); forwarded to the client. */
  apiKey?: string;
  /** Test overrides. */
  dimensions?: number;
  collection?: string;
}

export interface CreateMemoryStoreOptions {
  db: Db;
  qdrant?: QdrantOptions;
  /**
   * Explicit opt-in for a vector-less store (QS-26): ONLY for test/fixture
   * paths that never touch a vector-dependent operation — every search,
   * status transition, supersession, scope/sensitive toggle and rejection
   * THROWS on such a store. Production wiring must always pass `qdrant`.
   */
  sqlOnly?: true;
}

export function createMemoryStore(options: CreateMemoryStoreOptions): MemoryStore {
  return new MemoryStore(options.db, buildVectors(options));
}

/** The reconciliation actions for non-Nest callers (integration tests, eval). */
export function createMemoryReconciliation(options: CreateMemoryStoreOptions): {
  store: MemoryStore;
  reconciliation: MemoryReconciliation;
} {
  const vectors = buildVectors(options);
  const store = new MemoryStore(options.db, vectors);
  return { store, reconciliation: new MemoryReconciliation(options.db, store, vectors) };
}

/** Boot assertion (QS-26): a vector-less store must be explicitly marked. */
function buildVectors(options: CreateMemoryStoreOptions): MemoryVectorStore | undefined {
  if (options.qdrant) return new MemoryVectorStore(options.qdrant);
  if (!options.sqlOnly) {
    throw new Error(
      'createMemoryStore: no qdrant options — a vector-less MemoryStore silently has no ' +
        'index; pass `sqlOnly: true` ONLY for test/fixture paths that never exercise ' +
        'search, transitions or supersession (QS-26)',
    );
  }
  return undefined;
}

export interface CreateIntegritySweepOptions {
  db: Db;
  qdrant: QdrantOptions;
  s3: ObjectStoreOptions;
  instanceKeyDir: string;
  /** Source-row probes for the orphan-memory arm (decision 0024) — pass the
   * same adapters the composition roots bind to the saga. */
  sourceDeletions?: SourceDeletion[];
}

/** The on-demand sweep (npm run sweep / compose exec) builds through this. */
export function createIntegritySweep(options: CreateIntegritySweepOptions): IntegritySweep {
  return new IntegritySweep(
    options.db,
    new MemoryVectorStore(options.qdrant),
    new MemoryObjectStore(options.s3),
    options.instanceKeyDir,
    options.sourceDeletions ?? [],
  );
}
