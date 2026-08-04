import { Injectable, Module } from '@nestjs/common';
import type { Tx } from '../infrastructure/index';
import type { DerivedCascade } from '../memory/index';
import { SourceContextStore } from './persistence/source-context.store';

/**
 * Deletion coverage for the source context (V2.1 item 4.2).
 *
 * The context is content-bearing: its subjects and revision are the document's
 * own words, read off its opening. A row that survived its source would be a
 * fragment of an erased document under a signed receipt, so it goes with the
 * source through memory's DerivedCascade port, implemented here by the module
 * that owns the table. `cascadeForMemories` is a no-op: the context describes
 * the source, not any one memory.
 */
@Injectable()
export class SourceContextCascade implements DerivedCascade {
  readonly artifact = 'source_contexts';

  constructor(private readonly store: SourceContextStore) {}

  async cascadeForMemories(): Promise<number> {
    return 0;
  }

  async cascadeForSource(tx: Tx, sourceType: string, sourceId: string): Promise<number> {
    return this.store.deleteForSources(tx, [{ sourceType, sourceId }]);
  }
}

/** Own module, the SuppressedFactCascadeModule precedent: no dependency but
 * the store's own table access, so memory imports it without a cycle. */
@Module({
  providers: [SourceContextStore, SourceContextCascade],
  exports: [SourceContextStore, SourceContextCascade],
})
export class SourceContextCascadeModule {}
