import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata, Type } from '@nestjs/common';
import { MemoriesController } from './memories.controller';
import { RelationsController } from './relations.controller';
import { SourcesController } from './sources.controller';
import { IntegrityController, ReceiptsController } from './receipts.controller';
import { TimelineController } from './timeline.controller';
import { IntegritySweep } from './integrity-sweep';
import { MemoryStore } from './memory.store';
import { TimelineService } from './timeline.service';
import { MemoryReconciliation } from './reconciliation';
import {
  DeletionExecutor,
  DeletionSaga,
  DERIVED_CASCADES,
  INGESTION_GUARD,
  INSTANCE_KEY_DIR,
  SOURCE_DELETIONS,
} from './deletion-saga';
import type { DerivedCascade, IngestionGuard, SourceDeletion } from './deletion-saga';
import { MemoryVectorStore } from './persistence/vector-store';
import { MemoryObjectStore } from './persistence/object-store';
import { MemoryFileStore } from './file-store';

export interface MemoryModuleOptions {
  qdrantUrl: string;
  /** Qdrant API key (QS-4); forwarded to the client. */
  qdrantApiKey?: string;
  /** Determines the collection's vector size; recorded per memory. */
  embeddingModel: string;
  /** Test override for the vector size. */
  dimensions?: number;
  /** Object storage — the saga's byte-deletion leg + encryption check (0008);
   * `publicUrl` is the browser-reachable origin for presigned URLs (O1, §A.9). */
  s3: { url: string; publicUrl?: string; accessKey: string; secretKey: string; bucket: string };
  /** Where the instance signing keypair lives (§B.1, decision 0008). */
  instanceKeyDir: string;
  /**
   * Source-deletion adapters for source rows owned by other modules — bound by
   * the composition root, mirroring ingestion's SourceReader port (§A.1).
   */
  sourceDeletions?: { imports?: ModuleMetadata['imports']; adapters: Type<SourceDeletion>[] };
  /** Derived-artifact cascades (0013 ruling 6) — tasks today, bound like the
   * source deletions: memory defines the port, the deriving module implements. */
  derivedCascades?: { imports?: ModuleMetadata['imports']; adapters: Type<DerivedCascade>[] };
  /**
   * Pending-ingestion cancellation for the deletion saga (QS-5, decision
   * 0024) — REQUIRED so no production wiring can silently ship without the
   * delete-vs-ingestion serialization. Implemented by the ingestion module
   * (PipelineIngestionGuard); must be dependency-free (instantiated here).
   */
  ingestionGuard: Type<IngestionGuard>;
}

/**
 * memory — core domain (Addendum §A.1, §A.6; decision 0003 ruling 2).
 * Owns ALL storage access for memory data: the Postgres tables, the Qdrant
 * client AND the object-storage client (module-private — no other module may
 * import them; dependency-cruiser rule). Registered once by each composition
 * root with its storage options; global like the seams so consumers inject
 * MemoryStore without re-options (decision 0004 ruling 4 pattern).
 */
@Module({})
export class MemoryModule {
  static register(options: MemoryModuleOptions): DynamicModule {
    // Boot assertion (QS-26): a production-configured memory module ALWAYS has
    // a vector store — transitions and supersession must fail loudly, never
    // silently skip their Qdrant payload sync, if Qdrant is miswired.
    if (!options.qdrantUrl) {
      throw new Error('MemoryModule.register: qdrantUrl is required — see decision 0024 / QS-26');
    }
    return {
      module: MemoryModule,
      global: true,
      imports: [
        ...(options.sourceDeletions?.imports ?? []),
        ...(options.derivedCascades?.imports ?? []),
      ],
      controllers: [
        MemoriesController,
        RelationsController,
        SourcesController,
        ReceiptsController,
        IntegrityController,
        TimelineController,
      ],
      providers: [
        {
          provide: MemoryVectorStore,
          useFactory: () =>
            new MemoryVectorStore({
              url: options.qdrantUrl,
              apiKey: options.qdrantApiKey,
              embeddingModel: options.embeddingModel,
              dimensions: options.dimensions,
            }),
        },
        {
          provide: MemoryObjectStore,
          useFactory: () => new MemoryObjectStore(options.s3),
        },
        { provide: INSTANCE_KEY_DIR, useValue: options.instanceKeyDir },
        {
          provide: SOURCE_DELETIONS,
          useFactory: (...adapters: SourceDeletion[]) => adapters,
          inject: options.sourceDeletions?.adapters ?? [],
        },
        {
          provide: DERIVED_CASCADES,
          useFactory: (...adapters: DerivedCascade[]) => adapters,
          inject: options.derivedCascades?.adapters ?? [],
        },
        { provide: INGESTION_GUARD, useClass: options.ingestionGuard },
        MemoryStore,
        TimelineService,
        MemoryReconciliation,
        DeletionSaga,
        DeletionExecutor,
        IntegritySweep,
        MemoryFileStore,
      ],
      exports: [
        MemoryStore,
        TimelineService,
        MemoryReconciliation,
        DeletionSaga,
        DeletionExecutor,
        IntegritySweep,
        MemoryObjectStore,
        MemoryFileStore,
      ],
    };
  }
}
