import { Injectable } from '@nestjs/common';
import type { Tx } from '../infrastructure/index';
import type { DerivedCascade } from '../memory/index';
import { ConnectorItemLedger } from './persistence/item-ledger';

/**
 * Deletion coverage for the natural-key ledger (V2.5 item 8.1).
 *
 * A ledger row pointing at an erased source is a dangling provenance
 * reference, which may not outlive a receipt. The row itself is NOT deleted:
 * its source reference is cleared and it reads 'erased' thereafter, which is
 * what keeps the user's deletion standing: a later sync that lists the same
 * upstream item finds the erased row and never re-materializes the memory.
 * Nothing content-bearing lives on the row (identifiers and arithmetic
 * only), so keeping it survives the deletion promise intact.
 */
@Injectable()
export class ConnectorItemCascade implements DerivedCascade {
  readonly artifact = 'connector_items';

  constructor(private readonly ledger: ConnectorItemLedger) {}

  async cascadeForMemories(): Promise<number> {
    // Ledger rows key on sources, never on memories.
    return 0;
  }

  async cascadeForSource(tx: Tx, sourceType: string, sourceId: string): Promise<number> {
    return this.ledger.eraseForSource(tx, sourceType, sourceId);
  }
}
