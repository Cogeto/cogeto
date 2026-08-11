import { Injectable } from '@nestjs/common';
import type { Tx } from '../infrastructure/index';
import type { DerivedCascade } from '../memory/index';
import { ConfluencePageStore } from './persistence/page-store';

/**
 * Deletion coverage for the confluence provenance rows (V2.5 item 8.2):
 * titles and space names are the document's own words, so the row is
 * content-bearing and must be ERASED with its source, unlike the platform's
 * arithmetic-only ledger, which merely clears its reference.
 */
@Injectable()
export class ConfluencePageCascade implements DerivedCascade {
  readonly artifact = 'confluence_pages';

  constructor(private readonly store: ConfluencePageStore) {}

  async cascadeForMemories(): Promise<number> {
    // Provenance rows key on sources, never on memories.
    return 0;
  }

  async cascadeForSource(tx: Tx, sourceType: string, sourceId: string): Promise<number> {
    return this.store.eraseForSource(tx, sourceType, sourceId);
  }
}
