import { Injectable, Module } from '@nestjs/common';
import type { Tx } from '../infrastructure/index';
import type { DerivedCascade } from '../memory/index';
import { SourceRevisionStore } from './persistence/source-revision.store';

/**
 * Deletion coverage for revision links (V2.2 item 5.3): a link naming an
 * erased source on either side is a dangling provenance reference, so it goes
 * with the source. Metadata-only (the basis holds anchored values the
 * documents stated), counted nowhere on the receipt.
 */
@Injectable()
export class SourceRevisionCascade implements DerivedCascade {
  readonly artifact = 'source_revisions';

  constructor(private readonly revisions: SourceRevisionStore) {}

  async cascadeForMemories(): Promise<number> {
    return 0;
  }

  async cascadeForSource(tx: Tx, sourceType: string, sourceId: string): Promise<number> {
    return this.revisions.deleteForSources(tx, [{ sourceType, sourceId }]);
  }
}

/** Own module, the cascade-family precedent. */
@Module({
  providers: [SourceRevisionStore, SourceRevisionCascade],
  exports: [SourceRevisionStore, SourceRevisionCascade],
})
export class SourceRevisionCascadeModule {}
