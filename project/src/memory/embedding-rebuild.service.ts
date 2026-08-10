import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { MemoryVectorStore } from './persistence/vector-store';
import {
  beginEmbeddingRebuild,
  cancelEmbeddingRebuild,
  embeddingRebuildCorpus,
  resumeEmbeddingRebuild,
  runEmbeddingRebuildPass,
} from './embedding-rebuild';
import type {
  EmbeddingRebuildCorpus,
  EmbeddingRebuildPassDeps,
  EmbeddingRebuildPassResult,
  EmbeddingRebuildTarget,
} from './embedding-rebuild';
import { embeddingRebuildStatus } from './embedding-index';
import type { EmbeddingRebuildStatus } from './embedding-index';

/**
 * The app-side surface of the managed rebuild (V2.4 item 7.1 second half):
 * plan numbers, begin, resume, cancel, status. The providers module calls
 * this from its admin endpoints — the rebuild itself runs in the worker
 * (`memory.reindex_advance`), and the switch port is bound there, so this
 * service deliberately cannot switch anything.
 */
@Injectable()
export class EmbeddingRebuildService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly vectors: MemoryVectorStore,
  ) {}

  /** What a rebuild of this corpus costs: fact count and the token estimate
   * under the same chars/4 accounting the budget meter charges. */
  corpus(): Promise<EmbeddingRebuildCorpus> {
    return embeddingRebuildCorpus(this.db);
  }

  status(): Promise<EmbeddingRebuildStatus | null> {
    return embeddingRebuildStatus(this.db);
  }

  begin(request: {
    target: EmbeddingRebuildTarget;
    requestedBy: string;
    orgId?: string;
  }): Promise<void> {
    return beginEmbeddingRebuild(this.db, request);
  }

  resume(request: { requestedBy: string; orgId?: string }): Promise<void> {
    return resumeEmbeddingRebuild(this.db, request);
  }

  cancel(request: { requestedBy: string; orgId?: string }): Promise<void> {
    return cancelEmbeddingRebuild(this.db, this.vectors, request);
  }

  /**
   * One pass of the rebuild, with this module's db and vector store already
   * bound — the worker root supplies only what it alone can: the target-bound
   * gateway factory and the providers-side switch port.
   */
  runPass(
    deps: Omit<EmbeddingRebuildPassDeps, 'db' | 'vectors'>,
  ): Promise<EmbeddingRebuildPassResult> {
    return runEmbeddingRebuildPass({ ...deps, db: this.db, vectors: this.vectors });
  }
}
