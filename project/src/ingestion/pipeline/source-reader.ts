import type { MemoryScope } from '@cogeto/shared';
import type { Tx } from '../../infrastructure/index';
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
   * Email-path authorship (migration 0030; decision 0054): true when the
   * content is the user's OWN new text (a self-routed message that is not a
   * forwarded original), false when it is someone else's words, omitted when
   * unknown or not applicable (non-email sources). Derived memories carry it;
   * task derivation treats email as first-person ONLY when true.
   */
  authoredByUser?: boolean;
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
  /**
   * The admission checkpoint (decision 0024): re-verifies INSIDE the pipeline's
   * idempotency transaction, after the slow model stages and immediately before
   * any memory row is inserted, that the durable source row still exists.
   * Implementations MUST run the check on `tx` with a shared row lock
   * (`FOR KEY SHARE`), so it serializes against the deletion saga's
   * `FOR UPDATE` + DELETE of the same row: if the saga already committed the
   * source's deletion this returns false (the pipeline aborts admission as a
   * no-op); if the check acquires the lock first, the lock is held until the
   * pipeline commits, so the saga's enumeration then sees the fresh memories
   * and erases them under the receipt. Either way, no orphan can commit.
   *
   * Discard-mode file sources have no durable row by design — the pipeline
   * skips this checkpoint for them (SourceItem.stagingKey set); that mode is
   * covered by the saga's idempotency-key cancellation instead.
   */
  existsForAdmission(tx: Tx, sourceId: string): Promise<boolean>;
}

export const SOURCE_READERS = Symbol('SOURCE_READERS');
