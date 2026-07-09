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
  /**
   * Extract-and-discard (§A.9, F1 handoff §3): the transient staging object the
   * bytes were read from, present ONLY in discard mode. The pipeline schedules
   * its deletion AFTER the derived memories commit — so a discarded original is
   * removed only once its extraction is durable (never a memory-loss window).
   * A staging key never enters file_metadata, provenance, or any receipt.
   */
  stagingKey?: string;
}

export interface SourceReader {
  readonly sourceType: SourceType;
  load(sourceId: string): Promise<SourceItem | null>;
}

export const SOURCE_READERS = Symbol('SOURCE_READERS');
