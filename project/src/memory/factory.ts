import type { Db } from '../infrastructure/index';
import { MemoryStore } from './memory.store';
import { MemoryVectorStore } from './persistence/vector-store';
import { MemoryObjectStore } from './persistence/object-store';
import type { ObjectStoreOptions } from './persistence/object-store';
import { IntegritySweep } from './integrity-sweep';

/**
 * Composition helpers for non-Nest callers (entrypoint scripts, integration
 * tests in other modules). Take primitives only — the Qdrant and object-store
 * clients stay module-private (0003 ruling 2).
 */
export interface QdrantOptions {
  url: string;
  embeddingModel: string;
  /** Test overrides. */
  dimensions?: number;
  collection?: string;
}

export interface CreateMemoryStoreOptions {
  db: Db;
  qdrant?: QdrantOptions;
}

export function createMemoryStore(options: CreateMemoryStoreOptions): MemoryStore {
  const vectors = options.qdrant ? new MemoryVectorStore(options.qdrant) : undefined;
  return new MemoryStore(options.db, vectors);
}

export interface CreateIntegritySweepOptions {
  db: Db;
  qdrant: QdrantOptions;
  s3: ObjectStoreOptions;
  instanceKeyDir: string;
}

/** The on-demand sweep (npm run sweep / compose exec) builds through this. */
export function createIntegritySweep(options: CreateIntegritySweepOptions): IntegritySweep {
  return new IntegritySweep(
    options.db,
    new MemoryVectorStore(options.qdrant),
    new MemoryObjectStore(options.s3),
    options.instanceKeyDir,
  );
}
