import type { Db } from '../infrastructure/index';
import { MemoryStore } from './memory.store';
import { MemorySystemStore } from './memory-system.store';
import { MemoryReconciliation } from './reconciliation';
import { MemoryVectorStore } from './persistence/vector-store';
import type { MemoryVectorStoreOptions } from './persistence/vector-store';
import { MemoryObjectStore } from './persistence/object-store';
import type { ObjectStoreOptions } from './persistence/object-store';
import { IntegritySweep } from './integrity-sweep';
import type { SourceDeletion } from './deletion-saga';
import {
  beginEmbeddingRebuild,
  cancelEmbeddingRebuild,
  runEmbeddingRebuildPass,
} from './embedding-rebuild';
import type { EmbeddingRebuildPassDeps, EmbeddingRebuildPassResult } from './embedding-rebuild';
import { embeddingRebuildStatus, liveIndexBinding } from './embedding-index';
import type { EmbeddingRebuildStatus } from './embedding-index';

/**
 * Composition helpers for non-Nest callers (entrypoint scripts, integration
 * tests in other modules). Take primitives only — the Qdrant and object-store
 * clients stay module-private (0003 ruling 2).
 */
export interface QdrantOptions {
  url: string;
  embeddingModel: string;
  /** Qdrant API key; forwarded to the client. */
  apiKey?: string;
  /** Test overrides. */
  dimensions?: number;
  collection?: string;
}

export interface CreateMemoryStoreOptions {
  db: Db;
  qdrant?: QdrantOptions;
  /**
   * Explicit opt-in for a vector-less store: ONLY for test/fixture
   * paths that never touch a vector-dependent operation — every search,
   * status transition, supersession, scope/sensitive toggle and rejection
   * THROWS on such a store. Production wiring must always pass `qdrant`.
   */
  sqlOnly?: true;
}

export function createMemoryStore(options: CreateMemoryStoreOptions): MemoryStore {
  return new MemoryStore(options.db, buildVectors(options));
}

/**
 * The live-index binding for a bare (non-Nest) composition: the active
 * collection comes from the state row (migration 0053), read once — a CLI
 * lives for one run, so there is no version to watch. Explicit `collection`
 * or `dimensions` options keep their fixed target exactly (tests and tools
 * addressing one collection at one size predate the state row and must not
 * have it resolved out from under them).
 */
function bareLiveIndex(db: Db, qdrant: QdrantOptions): Pick<MemoryVectorStoreOptions, 'liveIndex'> {
  if (qdrant.collection || qdrant.dimensions !== undefined) return {};
  return {
    liveIndex: liveIndexBinding(db, {
      version: 0,
      tiers: { embedding: { model: qdrant.embeddingModel } },
    }),
  };
}

/**
 * The unscoped machine reads for non-Nest callers (V2.0 item 3.7). The CLIs
 * that run the nightly cycle by hand (`npm run dream`, the chat eval harness)
 * are the same worker-side caller the Nest wiring serves; `entrypoints/` is
 * where a tool composes what it needs (boundary contract, B19), and no request
 * path can reach a function only a CLI calls.
 */
export function createMemorySystemStore(options: CreateMemoryStoreOptions): MemorySystemStore {
  return new MemorySystemStore(options.db, buildVectors(options));
}

/** The reconciliation actions for non-Nest callers (integration tests, eval). */
export function createMemoryReconciliation(options: CreateMemoryStoreOptions): {
  store: MemoryStore;
  systemStore: MemorySystemStore;
  reconciliation: MemoryReconciliation;
} {
  const vectors = buildVectors(options);
  const store = new MemoryStore(options.db, vectors);
  return {
    store,
    systemStore: new MemorySystemStore(options.db, vectors),
    reconciliation: new MemoryReconciliation(options.db, store, vectors),
  };
}

/** Boot assertion: a vector-less store must be explicitly marked. */
function buildVectors(options: CreateMemoryStoreOptions): MemoryVectorStore | undefined {
  if (options.qdrant) {
    return new MemoryVectorStore({
      ...options.qdrant,
      ...bareLiveIndex(options.db, options.qdrant),
    });
  }
  if (!options.sqlOnly) {
    throw new Error(
      'createMemoryStore: no qdrant options: a vector-less MemoryStore silently has no ' +
        'index; pass `sqlOnly: true` ONLY for test/fixture paths that never exercise ' +
        'search, transitions or supersession',
    );
  }
  return undefined;
}

/**
 * The managed rebuild for non-Nest callers (the reindex CLI): the same engine
 * the worker job runs, composed from primitives so the Qdrant client stays
 * module-private. The CLI drives passes in-process; the single-flight lock
 * makes that safe beside a live worker doing the same.
 */
export function createEmbeddingRebuild(options: { db: Db; qdrant: QdrantOptions }): {
  begin: (request: Parameters<typeof beginEmbeddingRebuild>[1]) => Promise<void>;
  cancel: (request: Parameters<typeof cancelEmbeddingRebuild>[2]) => Promise<void>;
  status: () => Promise<EmbeddingRebuildStatus | null>;
  runPass: (
    deps: Omit<EmbeddingRebuildPassDeps, 'db' | 'vectors'>,
  ) => Promise<EmbeddingRebuildPassResult>;
} {
  const vectors = new MemoryVectorStore(options.qdrant);
  return {
    begin: (request) => beginEmbeddingRebuild(options.db, request),
    cancel: (request) => cancelEmbeddingRebuild(options.db, vectors, request),
    status: () => embeddingRebuildStatus(options.db),
    runPass: (deps) => runEmbeddingRebuildPass({ ...deps, db: options.db, vectors }),
  };
}

export interface CreateIntegritySweepOptions {
  db: Db;
  qdrant: QdrantOptions;
  s3: ObjectStoreOptions;
  instanceKeyDir: string;
  /** Source-row probes for the orphan-memory arm — pass the
   * same adapters the composition roots bind to the saga. */
  sourceDeletions?: SourceDeletion[];
}

/** The on-demand sweep (npm run sweep / compose exec) builds through this. */
export function createIntegritySweep(options: CreateIntegritySweepOptions): IntegritySweep {
  return new IntegritySweep(
    options.db,
    new MemoryVectorStore({ ...options.qdrant, ...bareLiveIndex(options.db, options.qdrant) }),
    new MemoryObjectStore(options.s3),
    options.instanceKeyDir,
    { sourceAdapters: options.sourceDeletions ?? [] },
  );
}
