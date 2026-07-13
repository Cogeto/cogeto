import type { Pool } from 'pg';
import type { Db } from '../../infrastructure/index';
import { MemoryObjectStore, reindexMemories } from '../../memory/index';
import type { ModelGateway } from '../../model-gateway/index';
import type { DemoApi } from './http-client';
import {
  acquireDemoResetLock,
  fileObjectKeys,
  releaseDemoResetLock,
  truncateDomainTables,
  waitForQuiescence,
} from './ops';
import { seedDemoWorld } from './seed';
import type { Logger } from './seed';
import type { Corpus } from './corpus';
import type { DemoEndState } from './assertions';

/** Thrown when a reset can't start because another already holds the lock (QS-33). */
export class DemoResetInProgressError extends Error {
  constructor() {
    super('a demo reset is already in progress — skipping this one');
    this.name = 'DemoResetInProgressError';
  }
}

export interface ResetDeps {
  pool: Pool;
  db: Db;
  api: DemoApi;
  ownerId: string;
  objects: MemoryObjectStore;
  gateway: ModelGateway;
  qdrantUrl: string;
  qdrantApiKey?: string;
  embeddingModel?: string;
  corpus?: Corpus;
  strict?: boolean;
  /** Task id to exclude from drain counts (scheduled reset runs inside the worker). */
  excludeTask?: string;
  log?: Logger;
}

/**
 * Tears down all demo data and re-seeds through the pipeline (decision 0022
 * ruling 2). The demo Principal and its token are preserved — only the world is
 * wiped — so an open browser tab keeps working across a reset. The instance is
 * single-tenant and disposable, so wiping every domain table IS wiping demo data.
 */
export async function resetDemoWorld(deps: ResetDeps): Promise<DemoEndState> {
  const log = deps.log ?? (() => undefined);

  // QS-33: hold the reset advisory lock for the whole wipe-and-reseed. Another
  // reset already running → skip cleanly rather than truncate mid-seed.
  const lock = await acquireDemoResetLock(deps.pool);
  if (!lock) throw new DemoResetInProgressError();
  try {
    log('tearing down demo data…');
    // 1. Drain first so no in-flight job resurrects a row after truncation.
    await waitForQuiescence(deps.pool, { excludeTask: deps.excludeTask });

    // 2. MinIO bytes: delete the stored objects before their metadata rows go.
    const keys = await fileObjectKeys(deps.pool);
    for (const key of keys) {
      await deps.objects.deleteObject(key).catch(() => undefined);
    }
    log(`  · removed ${keys.length} object(s) from storage`);

    // 3. Postgres: truncate every domain table (keep migrations + prompt registry).
    const truncated = await truncateDomainTables(deps.pool);
    log(`  · truncated ${truncated.length} table(s)`);

    // 4. Qdrant: reindex from the now-empty Postgres removes every orphan point
    //    (§A.4 — the reindex path must always work).
    const report = await reindexMemories({
      db: deps.db,
      gateway: deps.gateway,
      qdrantUrl: deps.qdrantUrl,
      qdrantApiKey: deps.qdrantApiKey,
      embeddingModel: deps.embeddingModel,
    });
    log(`  · cleared vector index (${report.orphansRemoved} orphan point(s) removed)`);

    log('re-seeding…');
    return await seedDemoWorld({
      api: deps.api,
      pool: deps.pool,
      ownerId: deps.ownerId,
      corpus: deps.corpus,
      strict: deps.strict,
      excludeTask: deps.excludeTask,
      log,
    });
  } finally {
    await releaseDemoResetLock(lock);
  }
}
