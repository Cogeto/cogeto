import type { MemoryScope } from '@cogeto/shared';
import type { SourceType } from '../../memory/index';

/**
 * Stage 1 (ingest) port: the pipeline reads source items through this
 * interface. Connector modules implement it for their source types and the
 * composition root binds the implementations (SOURCE_READERS), so ingestion
 * never touches a connector's tables (§A.1 rule 2) and never imports a
 * connector module (no cycle: connectors → ingestion only).
 */

export interface SourceItem {
  sourceType: SourceType;
  sourceId: string;
  ownerId: string;
  content: string;
  /** The source timestamp: relative temporal expressions resolve against it. */
  createdAt: Date;
  /**
   * Governance the derived memories inherit from the source. Notes are always
   * private/non-sensitive (omit → stage 5 defaults to private/false); file
   * uploads carry the uploader's scope selector and sensitive checkbox
   * (F1 handoff — derived facts inherit both).
   */
  scope?: MemoryScope;
  sensitive?: boolean;
}

export interface SourceReader {
  readonly sourceType: SourceType;
  load(sourceId: string): Promise<SourceItem | null>;
}

export const SOURCE_READERS = Symbol('SOURCE_READERS');
