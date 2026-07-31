import { Injectable } from '@nestjs/common';
import type { Tx } from '../infrastructure/index';
import type { DerivedCascade } from '../memory/index';
import { SuppressedFactLog } from './persistence/suppressed-fact-log';

/**
 * Deletion coverage for the suppressed-fact log (V2.0 item 3.3).
 *
 * The log is content-bearing: it holds the claim as extracted and the exact
 * source span it came from. A content-bearing table the deletion saga does not
 * reach would be a regression against the product's central promise, so it
 * joins the cascade the same way every other derived artifact does — through
 * memory's `DerivedCascade` port, implemented by the module that owns the table,
 * bound at the composition root. The saga never touches ingestion's tables.
 *
 * Two legs, because the log has two halves:
 *
 * - `cascadeForSource` covers the complete enumeration: every entry derived from
 *   an erased source, including the withheld ones that have no memory row at all
 *   and could not be reached any other way. The saga calls it once per enumerated
 *   source, so an email attachment's entries cannot survive its email.
 * - `cascadeForMemories` closes the cross-source gap the saga's own header
 *   documents: an admitted entry whose memory is erased goes with that memory
 *   even when the erasure came through a different source.
 *
 * Both run inside the saga's enumeration transaction and return counts that land
 * in the receipt under `suppressed_facts_removed`.
 */
@Injectable()
export class SuppressedFactCascade implements DerivedCascade {
  readonly artifact = 'suppressed_facts';

  constructor(private readonly log: SuppressedFactLog) {}

  async cascadeForMemories(tx: Tx, memoryIds: string[]): Promise<number> {
    return this.log.deleteForMemories(tx, memoryIds);
  }

  async cascadeForSource(tx: Tx, sourceType: string, sourceId: string): Promise<number> {
    return this.log.deleteForSources(tx, [{ sourceType, sourceId }]);
  }
}
