import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata, Type } from '@nestjs/common';
import { MemoriesController } from './memories.controller';
import { RelationsController } from './relations.controller';
import { SourcesController } from './sources.controller';
import { IntegrityController, ReceiptsController } from './receipts.controller';
import { InstanceController } from './instance.controller';
import { TimelineController } from './timeline.controller';
import { IntegritySweep } from './integrity-sweep';
import { MemoryStore } from './memory.store';
import { TimelineService } from './timeline.service';
import { MemoryReconciliation } from './reconciliation';
import {
  DELETION_SAGA_OPTIONS,
  DeletionExecutor,
  DeletionSaga,
  DERIVED_CASCADES,
  INGESTION_GUARD,
  INSTANCE_KEY_DIR,
  SOURCE_DELETIONS,
} from './deletion-saga';
import type {
  DeletionSagaOptions,
  DerivedCascade,
  IngestionGuard,
  SourceDeletion,
} from './deletion-saga';
import { SWEEP_OPTIONS } from './integrity-sweep';
import type { SweepOptions } from './integrity-sweep';
import { MemoryVectorStore } from './persistence/vector-store';
import { MemoryObjectStore } from './persistence/object-store';
import { MemoryFileStore } from './file-store';

export interface MemoryModuleOptions {
  qdrantUrl: string;
  /** Qdrant API key; forwarded to the client. */
  qdrantApiKey?: string;
  /** Determines the collection's vector size; recorded per memory. */
  embeddingModel: string;
  /** Test override for the vector size. */
  dimensions?: number;
  /** Object storage — the saga's byte-deletion leg + encryption check (0008);
   * `publicUrl` is the browser-reachable origin for presigned URLs (O1). */
  s3: { url: string; publicUrl?: string; accessKey: string; secretKey: string; bucket: string };
  /** Where the instance signing keypair lives (spec §11.1). */
  instanceKeyDir: string;
  /**
   * Source-deletion adapters for source rows owned by other modules — bound by
   * the composition root, mirroring ingestion's SourceReader port (spec §15).
   */
  sourceDeletions?: { imports?: ModuleMetadata['imports']; adapters: Type<SourceDeletion>[] };
  /** Derived-artifact cascades (0013 ruling 6) — chat answers and reply drafts
   * today, bound like the source deletions: memory defines the port, the
   * deriving module implements. */
  derivedCascades?: { imports?: ModuleMetadata['imports']; adapters: Type<DerivedCascade>[] };
  /**
   * Pending-ingestion cancellation for the deletion saga  — REQUIRED so no production wiring can silently ship without the
   * delete-vs-ingestion serialization. Implemented by the ingestion module
   * (PipelineIngestionGuard); must be dependency-free (instantiated here).
   */
  ingestionGuard: Type<IngestionGuard>;
}

/**
 * memory — core domain (spec §15).
 * Owns ALL storage access for memory data: the Postgres tables, the Qdrant
 * client AND the object-storage client (module-private — no other module may
 * import them; dependency-cruiser rule). Registered once by each composition
 * root with its storage options.
 *
 * NOT global since B13 closed (V2.0 item 3.6 part 4): each composition root
 * creates ONE instance and threads it through the registration options of
 * every module that injects a memory provider. Globality was the last unnamed
 * dependency in the graph.
 */
@Module({})
export class MemoryModule {
  static register(options: MemoryModuleOptions): DynamicModule {
    // Boot assertion: a production-configured memory module ALWAYS has
    // a vector store — transitions and supersession must fail loudly, never
    // silently skip their Qdrant payload sync, if Qdrant is miswired.
    if (!options.qdrantUrl) {
      throw new Error('MemoryModule.register: qdrantUrl is required, /');
    }
    return {
      module: MemoryModule,
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
        // The receipts' verification key (V2.0 item 3.6 part 2).
        InstanceController,
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
        // The saga's and the sweep's collaborators, resolved BY TOKEN into one
        // named options bag each (V2.0 item 3.6 part 4): identity, never
        // position. The port tokens above remain the binding surface; these
        // factories are where they meet the consuming service.
        {
          provide: DELETION_SAGA_OPTIONS,
          useFactory: (
            adapters: SourceDeletion[],
            vectors: MemoryVectorStore,
            derivedCascades: DerivedCascade[],
            ingestionGuard: IngestionGuard,
          ): DeletionSagaOptions => ({ adapters, vectors, derivedCascades, ingestionGuard }),
          inject: [SOURCE_DELETIONS, MemoryVectorStore, DERIVED_CASCADES, INGESTION_GUARD],
        },
        {
          provide: SWEEP_OPTIONS,
          useFactory: (sourceAdapters: SourceDeletion[]): SweepOptions => ({ sourceAdapters }),
          inject: [SOURCE_DELETIONS],
        },
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
