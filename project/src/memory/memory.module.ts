import { Module } from '@nestjs/common';
import { DeletionSaga, DeletionSagaStub, MemoryStore } from './memory.store';

/**
 * memory — core domain (Addendum §A.1, §A.6; decision 0003 ruling 2).
 * Owns ALL storage access for memory data: the Postgres tables (and, from
 * Session 2, the Qdrant client). The DRIZZLE handle comes from the global
 * DatabaseModule registered by the composition root.
 */
@Module({
  providers: [MemoryStore, { provide: DeletionSaga, useClass: DeletionSagaStub }],
  exports: [MemoryStore, DeletionSaga],
})
export class MemoryModule {}
