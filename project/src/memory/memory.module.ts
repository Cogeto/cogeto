import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata, Type } from '@nestjs/common';
import { MemoriesController } from './memories.controller';
import { SourcesController } from './sources.controller';
import { IntegrityController, ReceiptsController } from './receipts.controller';
import { IntegritySweep } from './integrity-sweep';
import { MemoryStore } from './memory.store';
import {
  DeletionExecutor,
  DeletionSaga,
  INSTANCE_KEY_DIR,
  SOURCE_DELETIONS,
} from './deletion-saga';
import type { SourceDeletion } from './deletion-saga';
import { MemoryVectorStore } from './persistence/vector-store';
import { MemoryObjectStore } from './persistence/object-store';

export interface MemoryModuleOptions {
  qdrantUrl: string;
  /** Determines the collection's vector size; recorded per memory. */
  embeddingModel: string;
  /** Test override for the vector size. */
  dimensions?: number;
  /** Object storage — the saga's byte-deletion leg + encryption check (0008). */
  s3: { url: string; accessKey: string; secretKey: string; bucket: string };
  /** Where the instance signing keypair lives (§B.1, decision 0008). */
  instanceKeyDir: string;
  /**
   * Source-deletion adapters for source rows owned by other modules — bound by
   * the composition root, mirroring ingestion's SourceReader port (§A.1).
   */
  sourceDeletions?: { imports?: ModuleMetadata['imports']; adapters: Type<SourceDeletion>[] };
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
    return {
      module: MemoryModule,
      global: true,
      imports: [...(options.sourceDeletions?.imports ?? [])],
      controllers: [MemoriesController, SourcesController, ReceiptsController, IntegrityController],
      providers: [
        {
          provide: MemoryVectorStore,
          useFactory: () =>
            new MemoryVectorStore({
              url: options.qdrantUrl,
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
        MemoryStore,
        DeletionSaga,
        DeletionExecutor,
        IntegritySweep,
      ],
      exports: [MemoryStore, DeletionSaga, DeletionExecutor, IntegritySweep, MemoryObjectStore],
    };
  }
}
