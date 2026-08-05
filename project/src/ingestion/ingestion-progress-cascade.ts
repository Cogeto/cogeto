import { Injectable, Module } from '@nestjs/common';
import type { Tx } from '../infrastructure/index';
import type { DerivedCascade } from '../memory/index';
import { IngestionProgressStore } from './persistence/ingestion-progress';

/**
 * Deletion coverage for the pipeline-progress rows (V2.2 item 5.1). One stage
 * name per source, metadata only, so this leg is provenance hygiene exactly
 * like the gate-refusal cascade: a stage row referencing an erased source is
 * a dangling identifier nothing should have to learn to ignore.
 *
 * `cascadeForMemories` is a no-op by construction: the row keys on the
 * source, never on a memory.
 */
@Injectable()
export class IngestionProgressCascade implements DerivedCascade {
  readonly artifact = 'ingestion_progress';

  constructor(private readonly progress: IngestionProgressStore) {}

  async cascadeForMemories(): Promise<number> {
    return 0;
  }

  async cascadeForSource(tx: Tx, sourceType: string, sourceId: string): Promise<number> {
    return this.progress.deleteForSources(tx, [{ sourceType, sourceId }]);
  }
}

/**
 * Own module, the ExtractionRefusalCascadeModule precedent: it depends on
 * nothing but the store's own table access, so memory can import it without a
 * cycle back through the pipeline.
 */
@Module({
  providers: [IngestionProgressStore, IngestionProgressCascade],
  exports: [IngestionProgressStore, IngestionProgressCascade],
})
export class IngestionProgressCascadeModule {}
