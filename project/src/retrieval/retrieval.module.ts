import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/index';

/**
 * retrieval — hybrid, fused, filtered search (Addendum §A.5). Composes the
 * memory module's Principal-gated search primitives (decision 0003 ruling 2);
 * never touches a client or table. Shell module until the Notes slice.
 */
@Module({
  imports: [MemoryModule],
})
export class RetrievalModule {}
