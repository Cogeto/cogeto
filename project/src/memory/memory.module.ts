import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { MemoriesController } from './memories.controller';
import { DeletionSaga, DeletionSagaStub, MemoryStore } from './memory.store';
import { MemoryVectorStore } from './persistence/vector-store';

export interface MemoryModuleOptions {
  qdrantUrl: string;
  /** Determines the collection's vector size; recorded per memory. */
  embeddingModel: string;
  /** Test override for the vector size. */
  dimensions?: number;
}

/**
 * memory — core domain (Addendum §A.1, §A.6; decision 0003 ruling 2).
 * Owns ALL storage access for memory data: the Postgres tables AND the Qdrant
 * client (module-private — no other module may import it; dependency-cruiser
 * rule). Registered once by each composition root with its Qdrant options;
 * global like the seams so consumers inject MemoryStore without re-options
 * (decision 0004 ruling 4 pattern).
 */
@Module({})
export class MemoryModule {
  static register(options: MemoryModuleOptions): DynamicModule {
    return {
      module: MemoryModule,
      global: true,
      controllers: [MemoriesController],
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
        MemoryStore,
        { provide: DeletionSaga, useClass: DeletionSagaStub },
      ],
      exports: [MemoryStore, DeletionSaga],
    };
  }
}
