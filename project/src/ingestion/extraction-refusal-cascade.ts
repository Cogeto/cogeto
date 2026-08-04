import { Injectable, Module } from '@nestjs/common';
import type { Tx } from '../infrastructure/index';
import type { DerivedCascade } from '../memory/index';
import { ExtractionGateStore } from './persistence/extraction-gate.store';

/**
 * Deletion coverage for the extraction-gate refusal ledger (V2.1 item 4.3).
 *
 * The ledger is metadata-only — reason, source identifiers, a timestamp, never
 * content — so this leg is provenance hygiene rather than a content-erasure
 * promise: a refusal row referencing an erased source is exactly the kind of
 * dangling identifier the nightly sweep would otherwise have to learn to
 * ignore. Same port, same binding pattern as the suppressed-fact cascade: the
 * saga never touches ingestion's tables.
 *
 * `cascadeForMemories` is a no-op by construction: a refused source produced
 * no memories, so nothing keys a refusal row to one.
 */
@Injectable()
export class ExtractionRefusalCascade implements DerivedCascade {
  readonly artifact = 'extraction_refusals';

  constructor(private readonly gate: ExtractionGateStore) {}

  async cascadeForMemories(): Promise<number> {
    return 0;
  }

  async cascadeForSource(tx: Tx, sourceType: string, sourceId: string): Promise<number> {
    return this.gate.deleteRefusalsForSources(tx, [{ sourceType, sourceId }]);
  }
}

/**
 * Own module, the SuppressedFactCascadeModule precedent: it depends on nothing
 * but the store's own table access, so memory can import it without a cycle
 * back through the pipeline.
 */
@Module({
  providers: [ExtractionGateStore, ExtractionRefusalCascade],
  exports: [ExtractionGateStore, ExtractionRefusalCascade],
})
export class ExtractionRefusalCascadeModule {}
