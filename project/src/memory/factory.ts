import type { Db } from '../infrastructure/index';
import { MemoryStore } from './memory.store';
import { MemoryVectorStore } from './persistence/vector-store';

/**
 * Composition helper for non-Nest callers (entrypoint scripts, integration
 * tests in other modules). Takes primitives only — the Qdrant client stays
 * module-private (0003 ruling 2).
 */
export interface CreateMemoryStoreOptions {
  db: Db;
  qdrant?: {
    url: string;
    embeddingModel: string;
    /** Test overrides. */
    dimensions?: number;
    collection?: string;
  };
}

export function createMemoryStore(options: CreateMemoryStoreOptions): MemoryStore {
  const vectors = options.qdrant
    ? new MemoryVectorStore({
        url: options.qdrant.url,
        embeddingModel: options.qdrant.embeddingModel,
        dimensions: options.qdrant.dimensions,
        collection: options.qdrant.collection,
      })
    : undefined;
  return new MemoryStore(options.db, vectors);
}
