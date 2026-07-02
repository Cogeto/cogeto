import { Module } from '@nestjs/common';
import { MemoryStore } from './memory.store';

/**
 * memory — core domain (Addendum §A.1, §A.6; decision 0003 ruling 2).
 * Owns ALL storage access: the Postgres tables and the Qdrant client.
 * Real implementation lands in S1-B (migration 0001) and the Notes slice.
 */
@Module({
  providers: [MemoryStore],
  exports: [MemoryStore],
})
export class MemoryModule {}
