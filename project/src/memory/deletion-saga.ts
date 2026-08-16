import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isRegisteredSourceType, SOURCE_TYPES } from '@cogeto/shared';
import type { MemoryScope, Principal } from '@cogeto/shared';
import {
  DRIZZLE,
  loadInstanceSigner,
  untranslatedError,
  userError,
  withTransactionalEnqueue,
  writeAudit,
} from '../infrastructure/index';
import type { Db, DbOrTx, InstanceSigner, Tx } from '../infrastructure/index';
import { deletionReceipt, fileMetadata, memory } from './persistence/tables';
import type { SourceType } from './persistence/tables';
import { MemoryVectorStore } from './persistence/vector-store';
import { MemoryObjectStore } from './persistence/object-store';
import { hashReceiptPayload, GENESIS_HASH } from './domain/receipt-chain';
import { liftContradictionsBeforeDeletion } from './reconciliation';
import { UserDirectory } from '../identity/index';

/**
 * The deletion saga (spec §11.1, spec §11.1) — the ONLY path that hard-deletes memories
 * (spec §15 rule 4). Three steps across three stores
 *
 *   1. requestSourceDeletion — ONE Postgres transaction: enumerate + delete the
 *      derived memory rows, delete file metadata, delete the source row, write
 *      the receipt (pending), enqueue the external job via the outbox, audit.
 *      If anything fails, the transaction aborts and nothing anywhere changed.
 *   2. DeletionExecutor.execute (worker, idempotent under the receipt id)
 *      delete the enumerated Qdrant points and MinIO objects — absent
 *      identifiers are success, retries re-run both legs safely.
 *   3. Same worker transaction: confirm the receipt with chain hash + instance
 *      signature. The receipt can NEVER read `confirmed` while any enumerated
 *      identifier could still exist: confirmation and the external legs share
 *      one attempt — an external failure rolls the confirmation back.
 *
 * Correctness of enumeration (spec §11.1's provability argument): every
 * memory row carries NOT NULL provenance and every write path preserves
 * it — including edit-supersession, which copies the predecessor's provenance
 * onto the successor. So "all memories derived from source S" IS the provenance
 * query, and same-source supersession chains are enumerated in full by
 * construction, with no graph walk needed.
 *
 * Cross-source chains (design decision, recorded in): when a
 * chain crosses sources — a successor was derived from a DIFFERENT source,
 * e.g. a reconciliation merge — deleting source S removes only S's members.
 * Surviving members whose `superseded_by` pointed at a deleted row get that
 * pointer nulled (also required by the FK), and the receipt records those ids
 * under `superseded_by_nulled`. The surviving fact's own provenance is intact;
 * only the replaced-by link to the erased row is gone — erasure of S must not
 * be reconstructable from what survives.
 */

/** Job type of the external-deletion leg (worker). */
export const DELETION_JOB_TYPE = 'deletion.execute';
/** Idempotency source_type for the job key: (deletion_receipt, <receipt id>). */
export const DELETION_JOB_SOURCE_TYPE = 'deletion_receipt';

/**
 * One source a departed user owns, as owner erasure enumerates it (issue #632).
 *
 * `scope` is the scope recorded on the SOURCE ROW, which is the only scope a
 * source has: a source type whose table carries no scope column reports
 * `private`, and its adapter says why in a comment rather than guessing.
 * Erasure never acts on this value alone — the saga re-checks the DERIVED facts
 * inside its own transaction, which is where a fact whose scope diverged from
 * its source is caught.
 */
export interface OwnedSourceRef {
  sourceId: string;
  scope: MemoryScope;
}

/**
 * Port for deleting a source row that lives in another module's table (the
 * exact mirror of ingestion's SourceReader port): the memory module defines
 * it, connector modules implement it, the composition root binds the two —
 * the saga never touches a connector's tables and the module graph stays
 * acyclic (spec §15 rule 2). `file` sources are handled inside this module via
 * file_metadata and need no adapter.
 */
export interface SourceDeletion {
  readonly sourceType: SourceType;
  /** Owner of the source row (locked FOR UPDATE), or null when absent. */
  ownerOf(tx: Tx, sourceId: string): Promise<string | null>;
  /** Deletes the source row inside the saga's enumeration transaction. */
  deleteSource(tx: Tx, sourceId: string): Promise<void>;
  /**
   * EVERY source of this type owned by `ownerId`, with the scope its row
   * records. Used only by owner erasure (issue #632), which needs the complete
   * set and not a page of it: a source left behind is a source the erasure did
   * not erase, and the catalog's listing functions are cursor-paged for a
   * screen rather than exhaustive.
   *
   * Unpaginated on purpose. This runs in the worker, once, over one departed
   * user's corpus, and any bound on it would be a silent partial erasure.
   *
   * OPTIONAL: an adapter that returns nothing is not skipped by accident but
   * by declaration. `chat` is the case — a message is erased with its
   * conversation, so listing both would enumerate the same content twice.
   */
  listForOwner?(db: DbOrTx, ownerId: string): Promise<OwnedSourceRef[]>;
  /**
   * Extra artifacts that must be enumerated and removed WITH this source, when a
   * source owns more than its own row + body memories. An
   * email source, for example, additionally owns the raw + sanitised-HTML
   * objects it stored, and its supported attachments are their own `file`
   * sources (each with file_metadata, an object, and derived memories). The saga
   * folds these into the SAME enumeration transaction and the SAME receipt, so a
   * source deletion stays all-or-nothing and the receipt counts everything.
   * Optional — note/chat/file sources return nothing extra.
   */
  enumerateCascade?(tx: Tx, sourceId: string): Promise<SourceCascade>;
  /**
   * Which of these bucket object keys are legitimately owned by this
   * connector's RETAINED sources? The integrity sweep's
   * orphaned-object arm validates objects against file_metadata; connectors
   * that store objects recorded elsewhere (email: raw originals + externalised
   * HTML on email_message) answer here so retained bytes are never mis-flagged
   * as orphans — while a genuinely abandoned object (no row) still is. The
   * probe reads only the connector's own tables (spec §15). Optional — note/chat
   * sources store no objects.
   */
  ownsObjectKeys?(db: DbOrTx, keys: readonly string[]): Promise<string[]>;
}

/**
 * The extra members a source cascades into deletion. `objectKeys`
 * are connector-owned MinIO objects deleted directly (the worker leg, absent =
 * success); `fileSubSourceKeys` are `file` source ids whose own memories,
 * file_metadata, and object are erased too. Both feed the ONE receipt.
 */
export interface SourceCascade {
  objectKeys: string[];
  fileSubSourceKeys: string[];
  /**
   * `chat` source ids (chat_message rows) whose derived memories fold into
   * the SAME enumeration transaction and the SAME receipt (— a
   * conversation source owns its messages the way an email owns its
   * attachments). The adapter's deleteSource removes the message rows; the
   * saga enumerates + deletes their memories here. Optional and additive —
   * the established enumeration-only extension pattern.
   */
  chatSubSourceIds?: string[];
}

export const SOURCE_DELETIONS = Symbol('SOURCE_DELETIONS');

/**
 * Why owner erasure left a source alone (issue #632). The two halves of the
 * one rule the owner fixed: shared material always stays, without exception.
 *
 * - `shared_source` — the source row itself records `scope: 'shared'`. Decided
 *   before the transaction, from the enumeration.
 * - `shared_derived_fact` — the source is private but at least one fact
 *   derived from it is shared, which happens when a user re-scopes a single
 *   memory after ingestion. Decided INSIDE the transaction, over the complete
 *   enumeration including cascade members, because that is the only place the
 *   full set is known.
 */
export type RetentionReason = 'shared_source' | 'shared_derived_fact';

/**
 * Control flow, never a failure: thrown inside the enumeration transaction to
 * roll it back when the erasure guard retains a source. It has to be a throw
 * rather than an early return because the ingestion guard has already consumed
 * the source's pipeline idempotency key by that point, and a source we are
 * KEEPING must not come out of this with its pending ingestion cancelled.
 */
class SourceRetainedError extends Error {
  constructor(readonly reason: RetentionReason) {
    super(`source retained: ${reason}`);
    this.name = 'SourceRetainedError';
  }
}

/**
 * Port for cascading DERIVED artifacts (chat answers, reply drafts, future
 * derivations) when their memories are erased — the third of the family
 * after SourceReader and SourceDeletion: memory defines it, the deriving
 * module implements it, composition roots bind it. Implementations delete
 * their own rows inside the enumeration transaction and return the count for
 * the receipt; the FK CASCADE remains as the safety net.
 */
export interface DerivedCascade {
  /** Names the artifact in counts_json (e.g. 'chat_messages'). */
  readonly artifact: string;
  cascadeForMemories(tx: Tx, memoryIds: string[]): Promise<number>;
  /**
   * Optional read-only twin of `cascadeForMemories`: how many artifacts
   * WOULD go — the confirm dialog's honest number. Never mutates.
   */
  countForMemories?(tx: Tx, memoryIds: string[]): Promise<number>;
  /**
   * Optional: cascade artifacts keyed by the SOURCE being deleted, not its
   * memories. A reply-draft approval derived from an email lives in
   * another module and references the email SOURCE id (not a memory id), so it
   * cannot be reached via `cascadeForMemories`. Runs in the same enumeration
   * transaction and returns the count folded into the receipt.
   *
   * Called once per ENUMERATED source, not once per deletion: the primary
   * source plus every cascaded member (an email's attachment `file` sources, a
   * conversation's `chat` messages). Suppressed-fact log entries hold source
   * content and spans and can exist with no memory row at all, so an
   * attachment's entries would otherwise survive its email. Implementations
   * that key on one source type simply return 0 for the others.
   */
  cascadeForSource?(tx: Tx, sourceType: string, sourceId: string): Promise<number>;
  /**
   * Optional: artifacts that belong to the OWNER rather than to particular
   * memories, and that must not outlive this deletion (audit 2.0 SEC-8).
   *
   * The Memory Passport is the case this exists for. A ready export is a signed
   * ZIP of everything the user could see when it was assembled, so after a
   * deletion it holds erased content that the receipt claims is gone, and the
   * download endpoint would still mint a presigned URL for it.
   *
   * Returns the object keys to erase. They join the receipt's `object_keys` and
   * are deleted by the WORKER leg like every other object, so the all-or-nothing
   * guarantee and the retry semantics are the existing ones: this runs inside
   * the enumeration transaction and performs no external side effect itself.
   */
  expireForOwner?(tx: Tx, ownerId: string): Promise<{ count: number; objectKeys: string[] }>;
}

export const DERIVED_CASCADES = Symbol('DERIVED_CASCADES');

/**
 * Cancellation outcome of a source's pending ingestion
 * - `cancelled`      — no run was in flight; the idempotency key is now
 *                      consumed, so any queued or future pipeline job for this
 *                      source no-ops at its claim.
 * - `already_ran`    — ingestion completed earlier (key already consumed);
 *                      the enumeration in this transaction sees everything.
 * - `run_in_flight`  — a pipeline run holds the run lock right now. Safe for
 *                      row-backed sources: the run's admission checkpoint
 *                      serializes against the source-row lock this transaction
 *                      already holds, and the run consumes its own key.
 */
export type IngestionCancellation = 'cancelled' | 'already_ran' | 'run_in_flight';

/**
 * Port for cancelling a source's pending ingestion inside the saga's
 * enumeration transaction — the fourth of the port family (SourceReader,
 * SourceDeletion, DerivedCascade): memory defines it, ingestion implements it
 * (it owns the pipeline job type), composition roots bind it. `waitForRun`
 * makes the call block until an in-flight run finishes — required for sources
 * with no durable row to serialize on (discard-mode files).
 */
export interface IngestionGuard {
  cancelPending(
    tx: Tx,
    sourceType: SourceType,
    sourceId: string,
    opts: { waitForRun: boolean },
  ): Promise<IngestionCancellation>;
}

export const INGESTION_GUARD = Symbol('INGESTION_GUARD');

/** Directory holding the instance signing keypair. */
export const INSTANCE_KEY_DIR = Symbol('INSTANCE_KEY_DIR');

/** counts_json contract — written by the saga, parsed back by the executor. */
const countsSchema = z.object({
  source: z.object({ type: z.string(), id: z.string() }),
  requested_by: z.string(),
  memory_ids: z.array(z.string()),
  memory_count: z.int(),
  /**
   * Derived tasks removed with the memories.
   *
   * PERMANENTLY OPTIONAL, and never written again . The task subsystem is gone, so no new receipt carries this field —
   * but every receipt that already does must keep parsing AND keep hashing to
   * the same value. The chain hashes the STORED counts_json verbatim
   * (canonicalize is unchanged and must stay unchanged), so a historical
   * receipt verifies exactly as it did before the removal. Removing the field
   * from this schema would break the executor's parse of those receipts; this
   * line is a contract, not dead code. Covered by
   * `receipt-chain-tasks-removed.spec.ts`.
   */
  tasks_removed: z.int().optional(),
  /** Assistant chat answers whose stored citations referenced erased memories,
   * redacted to a deletion marker (additive —
   * optional so earlier receipts parse unchanged; a count, not an identifier
   * the sweep ignores it). */
  chat_messages_redacted: z.int().optional(),
  /**
   * Memory Passport exports expired with this deletion (audit 2.0 SEC-8).
   * ADDITIVE and OPTIONAL, like every count before it: earlier receipts parse
   * unchanged and hash to the same value, so the chain verifies across the
   * change. Their object keys are in `object_keys`, so the sweep already checks
   * them absent; this field is the human-readable count.
   */
  passport_exports_expired: z.int().optional(),
  /** Reply-draft approvals derived from the deleted email source, whose drafted
   * body (grounded on the erased email + the user's memories) is redacted to a
   * deletion marker (; additive — optional so earlier receipts parse
   * unchanged; a count, not an identifier: the sweep ignores it). */
  reply_drafts_redacted: z.int().optional(),
  /** Chat messages removed with a conversation source (additive —
   * optional so earlier receipts parse unchanged; a count, not an identifier
   * the message rows go via the adapter's deleteSource, the sweep verifies
   * memories/points/objects as ever). */
  chat_messages_removed: z.int().optional(),
  /**
   * Suppressed-fact log entries erased with this source (V2.0 item 3.3). The
   * log is content-bearing (the claim as extracted, plus its exact span), so
   * the erasure claim would be incomplete without it. ADDITIVE and OPTIONAL,
   * like every count before it: earlier receipts parse unchanged and hash to
   * the same value, so the chain verifies across the change. A count, not an
   * identifier — the sweep verifies memories, points and objects as ever.
   */
  suppressed_facts_removed: z.int().optional(),
  /**
   * File read reports erased with this source (V2.1 item 4.1). The report
   * carries sheet names, which are the document's own words, so the erasure
   * claim would be incomplete without it. ADDITIVE and OPTIONAL, like every
   * count before it: earlier receipts parse unchanged and hash to the same
   * value, so the chain verifies across the change. A count, not an identifier.
   */
  file_read_reports_removed: z.int().optional(),
  /**
   * Chat attachment rows erased with a conversation source (V2.2 item 5.1).
   * A transient attachment's row holds the file's extracted text and its
   * name, so the erasure claim would be incomplete without it. ADDITIVE and
   * OPTIONAL, like every count before it: earlier receipts parse unchanged
   * and hash to the same value. A count, not an identifier.
   */
  chat_attachments_removed: z.int().optional(),
  /**
   * Findings reports expired with this deletion (V2.3 item 6.2). A rendered
   * report quotes verbatim source spans, so it is the second content-bearing
   * derived artifact after the passport and is covered the same way: expired
   * in the enumeration transaction, its object keys erased by the worker leg
   * and verified absent by the sweep. ADDITIVE and OPTIONAL, like every count
   * before it: earlier receipts parse unchanged and hash to the same value.
   */
  findings_reports_expired: z.int().optional(),
  /**
   * Connector natural-key ledger rows whose source reference was cleared
   * with this deletion (V2.5 item 8.1). The row itself survives as dedup
   * arithmetic in state 'erased' so a later sync cannot resurrect the
   * memory; the count records that the dangling reference was cleared.
   * ADDITIVE and OPTIONAL: earlier receipts parse and hash unchanged.
   */
  connector_items_erased: z.int().optional(),
  /**
   * ── The rest of the cascade (issue #635) ────────────────────────────────
   *
   * The saga registers sixteen `DerivedCascade` implementations and the nine
   * counts above named nine of them, so several classes were erased inside
   * the signed transaction without appearing in the artifact that attests to
   * it. Deletion was complete; the PROOF was partial, which for a receipt is
   * the same kind of defect as an incomplete erasure.
   *
   * Every field here is ADDITIVE and OPTIONAL on the established terms: a
   * receipt written before this change parses unchanged and, because the
   * chain hashes the STORED `counts_json` verbatim, hashes to exactly the
   * value it always did. Each is written only when non-zero, which is why a
   * deletion that touches none of them produces a payload byte-identical to
   * the pre-change one.
   *
   * Two of them are CONTENT-BEARING and are the reason this was worth fixing;
   * the rest are structural rows whose removal is still part of the act the
   * receipt attests to, and are counted so the artifact accounts for the
   * whole of it rather than for a chosen subset.
   */
  /**
   * CONTENT-BEARING. The anchoring context erased with this source (V2.1 item
   * 4.2): its subjects, document class and revision are the document's own
   * words, read out of its opening pages.
   */
  source_contexts_removed: z.int().optional(),
  /**
   * CONTENT-BEARING. Confluence provenance rows erased with this source
   * (V2.5 item 8.2): the page title and space name are the document's own
   * words.
   */
  confluence_pages_removed: z.int().optional(),
  /** Revision links naming the erased source on either side (V2.2 item 5.3). */
  source_revisions_removed: z.int().optional(),
  /** Extraction-gate refusal ledger rows for the erased source (V2.1 item 4.3). */
  extraction_refusals_removed: z.int().optional(),
  /** Pipeline-progress rows for the erased source (V2.2 item 5.1). */
  ingestion_progress_removed: z.int().optional(),
  /** Project assignments released because their container is gone (V2.5 item 8.3). */
  project_assignments_released: z.int().optional(),
  /**
   * `import_items` is deliberately ABSENT and is not an omission: its cascade
   * TOMBSTONES the row (clears the name, keeps the arithmetic) and returns 0
   * by construction, and receipts count removals. Naming it here would put a
   * permanent zero in every payload.
   */
  /** Qdrant point id = memory id (spec §4.2); duplicated for receipt readability. */
  point_ids: z.array(z.string()),
  object_keys: z.array(z.string()),
  superseded_by_nulled: z.array(z.string()),
  enumerated_at: z.string(),
});

export type ReceiptCounts = z.infer<typeof countsSchema>;

/** Parses a stored counts_json — how the sweep re-derives what to verify absent. */
export function parseReceiptCounts(value: unknown): ReceiptCounts {
  return countsSchema.parse(value);
}

/**
 * Everything the counts payload says was removed, added up (issue #635).
 *
 * The SEC-30 guard below used to ask this question with a hand-written
 * disjunction naming nine of the sixteen cascades, which meant a deletion
 * removing only an uncounted class reported "nothing erasable" and wrote no
 * receipt: the erasure happened and the proof did not. Reading it back off the
 * payload instead means the guard cannot drift from the schema — a class is
 * covered the moment it is counted, and adding a count is the only thing
 * anyone has to remember.
 *
 * Every numeric field in the payload is a non-negative count of something the
 * transaction removed, redacted or expired. `memory_count` is one of them and
 * is deliberately included: it is zero exactly when there were no memories,
 * so it can only agree with the caller's own `memory_ids.length` test.
 */
export function countedRemovals(counts: ReceiptCounts): number {
  return Object.values(counts).reduce<number>(
    (total, value) => (typeof value === 'number' ? total + value : total),
    0,
  );
}

export interface DeletionPreview {
  sourceType: SourceType;
  sourceId: string;
  memoryCount: number;
  objectCount: number;
  /** Chat messages a conversation deletion removes; absent otherwise. */
  messageCount?: number;
  /** Enumerated memories the user had explicitly approved — deleted knowingly. */
  userApprovedCount?: number;
}

/**
 * The registry boundary (spec §15.3): the validation the database enum used to
 * perform. An unregistered value is rejected at the API exactly as the enum
 * rejected it; a registered-but-defunct value passes, as it always did — a
 * defunct value is a known value (AGENTS.md), and the 1.x upgrade CLI deletes
 * through this very path.
 */
function assertSourceType(value: string): SourceType {
  if (!isRegisteredSourceType(value)) {
    throw untranslatedError.badRequest(`unknown source type '${value}'`);
  }
  return value;
}

/**
 * The saga's collaborators, by NAME (V2.0 item 3.6 part 4): four trailing
 * positional optionals on the service that hard-deletes data were the worst
 * place for an argument-order hazard. The Nest side builds this bag from the
 * existing port tokens in MemoryModule; manual harnesses name their fields.
 */
export interface DeletionSagaOptions {
  /** Source-row deletion adapters (the SOURCE_DELETIONS port). */
  adapters?: SourceDeletion[];
  /** Payload sync for lifted contradiction partners (0010 ruling 8). */
  vectors?: MemoryVectorStore;
  /** Derived-artifact cascades (0013 ruling 6). */
  derivedCascades?: DerivedCascade[];
  /** Pending-ingestion cancellation — always bound by
   * the composition roots; optional only for legacy test harnesses. */
  ingestionGuard?: IngestionGuard;
}

export const DELETION_SAGA_OPTIONS = Symbol('DELETION_SAGA_OPTIONS');

@Injectable()
export class DeletionSaga {
  private readonly adapters: Map<SourceType, SourceDeletion>;
  private readonly vectors?: MemoryVectorStore;
  private readonly derivedCascades: DerivedCascade[];
  private readonly ingestionGuard?: IngestionGuard;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    /** Every collaborator, by NAME — see DeletionSagaOptions. */
    @Optional() @Inject(DELETION_SAGA_OPTIONS) options?: DeletionSagaOptions,
  ) {
    this.adapters = new Map((options?.adapters ?? []).map((a) => [a.sourceType, a]));
    this.vectors = options?.vectors;
    this.derivedCascades = options?.derivedCascades ?? [];
    this.ingestionGuard = options?.ingestionGuard;
  }

  /** What a deletion WOULD remove — the confirm dialog's numbers. Read-only. */
  async previewSourceDeletion(
    principal: Principal,
    rawSourceType: string,
    sourceId: string,
  ): Promise<DeletionPreview> {
    const sourceType = assertSourceType(rawSourceType);
    return this.db.transaction(async (tx) => {
      const { rows, fileRow, adapter } = await this.loadAndAuthorize(
        tx,
        principal,
        sourceType,
        sourceId,
        { lock: false },
      );
      let memoryCount = rows.length;
      let objectCount = fileRow ? 1 : 0;
      let messageCount: number | undefined;
      let userApprovedCount: number | undefined;
      // Fold in the cascaded members (email: raw + HTML objects, attachment file
      // sources and their memories) so the confirm dialog's numbers are honest.
      if (adapter?.enumerateCascade) {
        const cascade = await adapter.enumerateCascade(tx, sourceId);
        objectCount += cascade.objectKeys.length;
        for (const fileKey of cascade.fileSubSourceKeys) {
          const subCount = await tx
            .select({ id: memory.id })
            .from(memory)
            .where(and(eq(memory.sourceType, 'file'), eq(memory.sourceId, fileKey)));
          memoryCount += subCount.length;
          const exists = await tx
            .select({ objectKey: fileMetadata.objectKey })
            .from(fileMetadata)
            .where(eq(fileMetadata.objectKey, fileKey));
          objectCount += exists.length;
        }
        // Conversation members: messages + their memories, plus the
        // knowing-deletion count the confirm surfaces (user_approved memories).
        if (cascade.chatSubSourceIds) {
          messageCount = cascade.chatSubSourceIds.length;
          const subRows =
            cascade.chatSubSourceIds.length === 0
              ? []
              : await tx
                  .select({ id: memory.id, status: memory.status })
                  .from(memory)
                  .where(
                    and(
                      eq(memory.sourceType, 'chat'),
                      inArray(memory.sourceId, cascade.chatSubSourceIds),
                    ),
                  );
          memoryCount += subRows.length;
          userApprovedCount = subRows.filter((r) => r.status === 'user_approved').length;
        }
      }
      return {
        sourceType,
        sourceId,
        memoryCount,
        objectCount,
        messageCount,
        userApprovedCount,
      };
    });
  }

  /**
   * Saga step one — the enumeration transaction. Authorization: only the owner
   * of the source (checked against the source row AND every derived memory);
   * non-owners get NotFound so the API does not leak source existence.
   */
  async requestSourceDeletion(
    principal: Principal,
    rawSourceType: string,
    sourceId: string,
  ): Promise<{ receiptId: string | null }> {
    return this.deleteSourceForSubject(
      { userId: principal.userId, orgId: principal.orgId },
      `user:${principal.userId}`,
      rawSourceType,
      sourceId,
      { retainShared: false },
    );
  }

  /**
   * Owner erasure's per-source call (issue #632): the same saga, acting for a
   * SUBJECT who cannot authenticate, invoked by an ADMINISTRATOR who is what
   * the audit trail records.
   *
   * `retainShared` is always on here, and that is the whole difference in
   * behaviour. Nothing else about the deletion changes: same cascades, same
   * single transaction, same receipt, same chain, same sweep coverage.
   *
   * Returns `retained` instead of a receipt when the guard kept the source,
   * with the reason, so the caller can report honestly rather than counting a
   * retention as a failure.
   */
  async eraseOwnedSource(
    subject: { userId: string; orgId: string },
    actor: string,
    sourceType: string,
    sourceId: string,
  ): Promise<{ receiptId: string | null; retained?: RetentionReason }> {
    return this.deleteSourceForSubject(subject, actor, sourceType, sourceId, {
      retainShared: true,
    });
  }

  /**
   * The same enumeration transaction, with WHO it acts for separated from WHO
   * asked (issue #632).
   *
   * Owner erasure needs to delete a departed user's sources: the ownership
   * check, the receipt's `requested_by`, and every owner-keyed cascade must key
   * on the SUBJECT, while the audit trail must record the ADMINISTRATOR who
   * invoked it. Every other property of the saga — the cascades, the
   * all-or-nothing transaction, the receipt, the chain, the sweep — is
   * unchanged, because this IS that method; `requestSourceDeletion` is now a
   * thin call into it with subject and actor being the same person, which is
   * what they have always been.
   *
   * `subject` is a plain `{ userId, orgId }` and never a Principal, because the
   * subject of an erasure CANNOT authenticate: their account is deactivated or
   * gone from the identity provider, which is the state the feature exists for.
   * The org comes from the administrator, which in a single-tenant instance is
   * the same org, and is used only for audit stamping.
   *
   * `retainShared` is the erasure guard. See the check at the enumeration site.
   */
  private async deleteSourceForSubject(
    subject: { userId: string; orgId: string },
    actor: string,
    rawSourceType: string,
    sourceId: string,
    options: { retainShared: boolean },
  ): Promise<{ receiptId: string | null; retained?: RetentionReason }> {
    const sourceType = assertSourceType(rawSourceType);
    if (!sourceId.trim()) throw untranslatedError.badRequest('source id must not be blank');
    // Everything below keys on the SUBJECT. `roles` and the display fields are
    // never read on this path (the role check happened at the controller), so
    // the subject is representable without an identity-provider lookup — which
    // is the requirement, since a departed user may no longer exist there.
    const principal = { userId: subject.userId, orgId: subject.orgId } as Principal;
    // Recorded in the audit detail only when someone else acted: an ordinary
    // deletion's entry is unchanged, byte for byte.
    const onBehalfOf =
      actor === `user:${subject.userId}` ? {} : { onBehalfOf: subject.userId, erasure: true };

    try {
      return await this.db.transaction(async (tx) => {
        // Lock order: source row FIRST, then the ingestion
        // guard, then the memory rows — the same source-before-memories order the
        // pipeline uses, so the two transactions can never deadlock on it.
        const { fileRow, adapter, sourceOwner } = await this.resolveSource(
          tx,
          sourceType,
          sourceId,
          {
            lock: true,
          },
        );
        if (sourceOwner !== null && sourceOwner !== principal.userId) {
          throw userError.notFound(
            'source.notFound',
            'source {{sourceType}}/{{sourceId}} not found',
            {
              sourceType,
              sourceId,
            },
          );
        }

        // Cancel pending ingestion BEFORE enumerating: a queued pipeline
        // job finds its idempotency key consumed and no-ops; an in-flight run is
        // reported and left to its own admission checkpoint, which serializes
        // against the source-row lock held above. Discard-mode file sources have
        // no row to serialize on, so for them the guard WAITS the run out — the
        // enumeration below then sees whatever that run committed.
        const ingestion = this.ingestionGuard
          ? await this.ingestionGuard.cancelPending(tx, sourceType, sourceId, {
              // Discard-mode object-backed sources have no durable row to
              // serialize on, so the guard waits an in-flight run out.
              waitForRun: SOURCE_TYPES[sourceType].objectBacked && !fileRow,
            })
          : null;

        const rows = await this.enumerateAndAuthorize(tx, principal, sourceType, sourceId, {
          lock: true,
          sourceOwner,
        });

        // Cascade members: fold the source's extra objects and
        // its attachment `file` sub-sources into THIS enumeration transaction, so
        // they share the one receipt and the all-or-nothing guarantee. The
        // sub-sources' memories join `rows`; their objects join `cascadeObjectKeys`.
        const cascade = adapter?.enumerateCascade
          ? await adapter.enumerateCascade(tx, sourceId)
          : null;
        const cascadeObjectKeys: string[] = cascade ? [...cascade.objectKeys] : [];
        if (cascade) {
          for (const fileKey of cascade.fileSubSourceKeys) {
            const removedKey = await this.cascadeFileSubSource(tx, principal, fileKey, rows);
            if (removedKey) cascadeObjectKeys.push(removedKey);
          }
        }
        // Conversation members: every message's chat-derived memories join
        // the SAME enumeration and receipt. Pending per-message captures are
        // cancelled first; the message rows themselves go with the
        // adapter's deleteSource below.
        const chatMessagesRemoved = cascade?.chatSubSourceIds?.length ?? null;
        if (cascade?.chatSubSourceIds && cascade.chatSubSourceIds.length > 0) {
          if (this.ingestionGuard) {
            for (const messageId of cascade.chatSubSourceIds) {
              await this.ingestionGuard.cancelPending(tx, 'chat', messageId, { waitForRun: false });
            }
          }
          const subRows = await tx
            .select()
            .from(memory)
            .where(
              and(
                eq(memory.sourceType, 'chat'),
                inArray(memory.sourceId, cascade.chatSubSourceIds),
              ),
            )
            .for('update');
          if (subRows.some((r) => r.ownerId !== principal.userId)) {
            throw userError.notFound(
              'source.notFound',
              'source {{sourceType}}/{{sourceId}} not found',
              {
                sourceType,
                sourceId,
              },
            );
          }
          rows.push(...subRows);
        }

        // ── The erasure guard: shared material always stays (issue #632) ───────
        //
        // `rows` is now the COMPLETE enumeration — the source's own memories plus
        // every cascade member's (an email's attachments, a conversation's
        // messages). That completeness is the point: this is the only place in
        // the codebase that knows the full set a single deletion would remove,
        // so it is the only honest place to ask whether any of it is shared.
        //
        // A source is private and yet can hold a SHARED derived fact: scope is
        // stamped from the source at ingestion, and a user can change a single
        // memory's scope afterwards from the drawer. The saga deletes by
        // provenance, so erasing that source would take the shared fact with it.
        // The rule the owner fixed is that shared material always stays, without
        // exception, so when any enumerated fact is shared the WHOLE source is
        // retained and nothing here is touched.
        //
        // Retaining more than strictly necessary is the deliberate direction: the
        // alternative — erasing the private facts and keeping the shared one —
        // would leave a shared claim whose source is gone, which is an orphan
        // this product's provenance rules do not permit, and would make the
        // remaining fact unverifiable against the span it came from.
        //
        // It throws rather than returns so the transaction ROLLS BACK: by this
        // point the ingestion guard has already consumed the source's pipeline
        // idempotency key, and a retained source must not come out of this with
        // its pending ingestion silently cancelled.
        if (options.retainShared && rows.some((row) => row.scope === 'shared')) {
          throw new SourceRetainedError('shared_derived_fact');
        }

        const memoryIds = rows.map((r) => r.id);

        // Contradiction lift: surviving partners of
        // unresolved relations touching a doomed row are restored to their
        // recorded prior status — an accusation whose evidence is being erased
        // does not stick. The relation rows go with the memories (FK CASCADE).
        const liftedPartners = await liftContradictionsBeforeDeletion(
          tx,
          memoryIds,
          this.vectors,
          principal.orgId,
        );

        // Derived-artifact cascades (0013 ruling 6): counted deletes inside the
        // enumeration transaction, before the memory rows go (the FK CASCADE
        // stays as the safety net).
        let chatMessagesRedacted = 0;
        let replyDraftsRedacted = 0;
        let passportExportsExpired = 0;
        let findingsReportsExpired = 0;
        let suppressedFactsRemoved = 0;
        let fileReadReportsRemoved = 0;
        let chatAttachmentsRemoved = 0;
        let connectorItemsErased = 0;
        // The rest of the cascade (issue #635): counted so the receipt accounts
        // for the whole act, not a subset of it.
        let sourceContextsRemoved = 0;
        let confluencePagesRemoved = 0;
        let sourceRevisionsRemoved = 0;
        let extractionRefusalsRemoved = 0;
        let ingestionProgressRemoved = 0;
        let projectAssignmentsReleased = 0;
        const ownerExpiredObjectKeys: string[] = [];
        // Every source this deletion erases, not just the one it was asked for:
        // the primary source plus its cascaded members. Source-keyed artifacts
        // that can exist without a memory row — the suppressed-fact log's withheld
        // entries — are only reachable through the full list.
        const enumeratedSources: { sourceType: string; sourceId: string }[] = [
          { sourceType, sourceId },
          ...(cascade?.fileSubSourceKeys ?? []).map((key) => ({
            sourceType: 'file',
            sourceId: key,
          })),
          ...(cascade?.chatSubSourceIds ?? []).map((id) => ({ sourceType: 'chat', sourceId: id })),
        ];
        for (const cascade of this.derivedCascades) {
          const removed = await cascade.cascadeForMemories(tx, memoryIds);
          // assistant answers that cited erased memories
          // are redacted to a deletion marker by the chat cascade; the receipt
          // counts them so the erasure claim is complete, not just row-deep.
          if (cascade.artifact === 'chat_messages') chatMessagesRedacted += removed;
          // suppressed-fact entries whose memory is erased through a
          // supersession chain that crossed sources — the by-source leg below is
          // the complete enumeration, this closes the cross-source gap.
          if (cascade.artifact === 'suppressed_facts') suppressedFactsRemoved += removed;
          // reply-draft approvals derived from THIS source (by source id,
          // not memory id) — their drafted body is redacted so a "provably
          // deleted" receipt no longer over-claims while the draft survives.
          if (cascade.cascadeForSource) {
            for (const ref of enumeratedSources) {
              const redacted = await cascade.cascadeForSource(tx, ref.sourceType, ref.sourceId);
              if (cascade.artifact === 'reply_drafts') replyDraftsRedacted += redacted;
              if (cascade.artifact === 'suppressed_facts') suppressedFactsRemoved += redacted;
              // What the reading layer made of an erased file: sheet names are
              // content, and the report can exist with no memory at all (a file
              // that yielded nothing readable), so only this leg reaches it.
              if (cascade.artifact === 'file_read_reports') fileReadReportsRemoved += redacted;
              // Conversation attachments (V2.2 item 5.1): a transient row holds
              // the file's extracted text, so it goes with its conversation; the
              // file leg of the same cascade only CLEARS a durable link's name
              // and returns 0, so this count is real removals only.
              if (cascade.artifact === 'chat_attachments') chatAttachmentsRemoved += redacted;
              // Connector items (V2.5 item 8.1): the natural-key ledger row
              // pointing at an erased source has its source reference cleared
              // and reads 'erased' thereafter, so a later sync can never
              // resurrect the deleted memory. Arithmetic survives; nothing
              // content-bearing lives there.
              if (cascade.artifact === 'connector_items') connectorItemsErased += redacted;
              // The anchoring context: subjects, class and revision read out of
              // the document's own opening. Content, and the receipt now says so.
              if (cascade.artifact === 'source_contexts') sourceContextsRemoved += redacted;
              // Confluence provenance: the page title and space name are the
              // document's own words, so this row is erased, not merely cleared.
              if (cascade.artifact === 'confluence_pages') confluencePagesRemoved += redacted;
              // The remaining structural legs. Not content, but still removals
              // performed inside the signed transaction.
              if (cascade.artifact === 'source_revisions') sourceRevisionsRemoved += redacted;
              if (cascade.artifact === 'extraction_refusals') extractionRefusalsRemoved += redacted;
              if (cascade.artifact === 'ingestion_progress') ingestionProgressRemoved += redacted;
              if (cascade.artifact === 'project_assignments_released') {
                projectAssignmentsReleased += redacted;
              }
            }
          }
          // SEC-8: owner-scoped artifacts that would outlive the deletion. Their
          // objects join `objectKeys` below, so the worker leg erases them and
          // the sweep verifies them absent, exactly like a file or an email body.
          if (cascade.expireForOwner) {
            const expired = await cascade.expireForOwner(tx, principal.userId);
            if (cascade.artifact === 'passport_exports') {
              passportExportsExpired += expired.count;
            }
            // V2.3 item 6.2: findings reports quote verbatim spans, so they are
            // the second artifact under the same rule.
            if (cascade.artifact === 'findings_reports') {
              findingsReportsExpired += expired.count;
            }
            ownerExpiredObjectKeys.push(...expired.objectKeys);
          }
        }

        // Cross-source chain handling (see header): surviving rows pointing at a
        // deleted row get the pointer nulled — recorded in the receipt. Doing it
        // before the DELETE also satisfies the superseded_by FK.
        let nulledPointers: string[] = [];
        if (memoryIds.length > 0) {
          const nulled = await tx
            .update(memory)
            .set({ supersededBy: null, updatedAt: new Date() })
            .where(and(inArray(memory.supersededBy, memoryIds), notInArray(memory.id, memoryIds)))
            .returning({ id: memory.id });
          nulledPointers = nulled.map((r) => r.id);
          await tx.delete(memory).where(inArray(memory.id, memoryIds));
        }

        const objectKeys: string[] = [];
        if (SOURCE_TYPES[sourceType].objectBacked && fileRow) {
          await tx.delete(fileMetadata).where(eq(fileMetadata.objectKey, sourceId));
          objectKeys.push(sourceId);
        }
        // The source's cascaded objects (email raw + HTML + attachment objects),
        // deduped so a key can never be double-listed in the receipt.
        for (const key of cascadeObjectKeys) if (!objectKeys.includes(key)) objectKeys.push(key);
        // SEC-8: expired passport export artifacts, deduped the same way.
        for (const key of ownerExpiredObjectKeys)
          if (!objectKeys.includes(key)) objectKeys.push(key);
        if (adapter) await adapter.deleteSource(tx, sourceId);

        const counts: ReceiptCounts = {
          source: { type: sourceType, id: sourceId },
          requested_by: principal.userId,
          memory_ids: memoryIds,
          memory_count: memoryIds.length,
          // `tasks_removed` is deliberately ABSENT from new receipts  and stays optional in the schema forever, so the historical
          // ones that carry it still parse and still verify.
          chat_messages_redacted: chatMessagesRedacted,
          reply_drafts_redacted: replyDraftsRedacted,
          ...(passportExportsExpired > 0
            ? { passport_exports_expired: passportExportsExpired }
            : {}),
          ...(findingsReportsExpired > 0
            ? { findings_reports_expired: findingsReportsExpired }
            : {}),
          ...(chatMessagesRemoved === null ? {} : { chat_messages_removed: chatMessagesRemoved }),
          ...(suppressedFactsRemoved > 0
            ? { suppressed_facts_removed: suppressedFactsRemoved }
            : {}),
          ...(fileReadReportsRemoved > 0
            ? { file_read_reports_removed: fileReadReportsRemoved }
            : {}),
          ...(chatAttachmentsRemoved > 0
            ? { chat_attachments_removed: chatAttachmentsRemoved }
            : {}),
          ...(connectorItemsErased > 0 ? { connector_items_erased: connectorItemsErased } : {}),
          // Written only when non-zero, so a deletion touching none of these
          // produces a payload byte-identical to the pre-change one (issue #635).
          ...(sourceContextsRemoved > 0 ? { source_contexts_removed: sourceContextsRemoved } : {}),
          ...(confluencePagesRemoved > 0
            ? { confluence_pages_removed: confluencePagesRemoved }
            : {}),
          ...(sourceRevisionsRemoved > 0
            ? { source_revisions_removed: sourceRevisionsRemoved }
            : {}),
          ...(extractionRefusalsRemoved > 0
            ? { extraction_refusals_removed: extractionRefusalsRemoved }
            : {}),
          ...(ingestionProgressRemoved > 0
            ? { ingestion_progress_removed: ingestionProgressRemoved }
            : {}),
          ...(projectAssignmentsReleased > 0
            ? { project_assignments_released: projectAssignmentsReleased }
            : {}),
          point_ids: memoryIds,
          object_keys: objectKeys,
          superseded_by_nulled: nulledPointers,
          enumerated_at: new Date().toISOString(),
        };
        // SEC-30: a receipt attests ERASURE, so it is only written when something
        // was actually erased. Removing the SOURCE ROW counts: deleting a
        // just-captured note whose pipeline has not run yet erases the note and
        // consumes the pipeline's idempotency key so the content can never
        // resurrect, and a receipt reading "0 memories, 0 objects" is the honest
        // record of exactly that, not noise.
        //
        // Which leaves this guard covering the genuinely vacuous case: no source
        // row, no memories, no objects, no derived artifacts. In practice
        // `enumerateAndAuthorize` already 404s there (`sourceOwner === null &&
        // rows.length === 0`), so this is defence in depth rather than a path the
        // API reaches today. It is kept because the alternative is trusting that
        // invariant to hold through every future source type: a signed, chained
        // attestation that nothing happened is the one thing the ledger must never
        // contain.
        const sourceRowRemoved = sourceOwner !== null || fileRow !== null;
        // Derived from `counts` rather than from a hand-kept disjunction
        // (issue #635) — see countedRemovals for why.
        const erasedSomething =
          sourceRowRemoved ||
          memoryIds.length > 0 ||
          objectKeys.length > 0 ||
          countedRemovals(counts) > 0;
        if (!erasedSomething) {
          await writeAudit(tx, {
            // The ACTOR, which is the subject themselves for an ordinary
            // deletion and the administrator for an owner erasure (issue #632).
            actor,
            action: 'source.deleted_empty',
            entityType: 'source',
            entityId: sourceId,
            detail: {
              sourceType,
              reason: 'nothing erasable derived from this source',
              ...onBehalfOf,
            },
            orgId: principal.orgId,
            // The SUBJECT: the detail gate serves the person whose material it
            // was, which is the point of recording it.
            ownerId: principal.userId,
          });
          return { receiptId: null };
        }

        const [receipt] = await tx
          .insert(deletionReceipt)
          .values({ sourceType, sourceId, countsJson: counts, status: 'pending' })
          .returning({ id: deletionReceipt.id });
        const receiptId = receipt!.id;

        await withTransactionalEnqueue(
          tx,
          {
            type: 'source.deletion_requested',
            payload: { source_type: sourceType, source_id: sourceId, receipt_id: receiptId },
          },
          {
            type: DELETION_JOB_TYPE,
            payload: { source_type: DELETION_JOB_SOURCE_TYPE, source_id: receiptId },
          },
        );
        await writeAudit(tx, {
          actor,
          action: 'source.deletion_requested',
          entityType: 'deletion_receipt',
          entityId: receiptId,
          detail: {
            sourceType,
            sourceId,
            memoryCount: memoryIds.length,
            objectCount: objectKeys.length,
            supersededByNulled: nulledPointers.length,
            contradictionsLifted: liftedPartners,
            chatMessagesRedacted,
            replyDraftsRedacted,
            chatMessagesRemoved,
            suppressedFactsRemoved,
            // The cancellation trace: how pending ingestion was resolved.
            ingestionCancellation: ingestion,
            // Present only when actor and subject differ (issue #632), so an
            // ordinary deletion's entry is byte-identical to before.
            ...onBehalfOf,
          },
          orgId: principal.orgId,
          ownerId: principal.userId,
        });
        return { receiptId };
      });
    } catch (error) {
      // The erasure guard rolled the transaction back. Not a failure: the
      // source is deliberately kept, and the caller records why.
      if (error instanceof SourceRetainedError) {
        return { receiptId: null, retained: error.reason };
      }
      throw error;
    }
  }

  /**
   * Enumerates the derived memories and resolves + checks the source owner —
   * the preview path (read-only). The deletion path composes the same two
   * halves directly so the ingestion guard can run between them.
   * NotFound when neither a source row nor derived memories exist, and for
   * any owner mismatch (existence must not leak).
   */
  private async loadAndAuthorize(
    tx: Tx,
    principal: Principal,
    sourceType: SourceType,
    sourceId: string,
    opts: { lock: boolean },
  ) {
    const { fileRow, adapter, sourceOwner } = await this.resolveSource(tx, sourceType, sourceId, {
      lock: opts.lock,
    });
    if (sourceOwner !== null && sourceOwner !== principal.userId) {
      throw userError.notFound('source.notFound', 'source {{sourceType}}/{{sourceId}} not found', {
        sourceType,
        sourceId,
      });
    }
    const rows = await this.enumerateAndAuthorize(tx, principal, sourceType, sourceId, {
      lock: opts.lock,
      sourceOwner,
    });
    return { rows, fileRow, adapter };
  }

  /** Resolves (and under `lock` FOR UPDATE-locks) the source row + its owner. */
  private async resolveSource(
    tx: Tx,
    sourceType: SourceType,
    sourceId: string,
    opts: { lock: boolean },
  ): Promise<{
    fileRow: typeof fileMetadata.$inferSelect | undefined;
    adapter: SourceDeletion | undefined;
    sourceOwner: string | null;
  }> {
    let fileRow: typeof fileMetadata.$inferSelect | undefined;
    let adapter: SourceDeletion | undefined;
    let sourceOwner: string | null;

    // Object-backed sources (registry metadata) are the ones whose source row
    // IS this module's file_metadata — resolved here, no adapter. Everything
    // else resolves through its owning module's SourceDeletion adapter.
    if (SOURCE_TYPES[sourceType].objectBacked) {
      const fileQuery = tx.select().from(fileMetadata).where(eq(fileMetadata.objectKey, sourceId));
      fileRow = (opts.lock ? await fileQuery.for('update') : await fileQuery)[0];
      sourceOwner = fileRow?.ownerId ?? null;
    } else {
      adapter = this.adapters.get(sourceType);
      if (!adapter) {
        throw untranslatedError.badRequest(
          `no deletion adapter registered for source type '${sourceType}'`,
        );
      }
      sourceOwner = await adapter.ownerOf(tx, sourceId);
    }
    return { fileRow, adapter, sourceOwner };
  }

  /**
   * Cascades one attachment `file` sub-source inside the enumeration transaction
   * cancel its pending ingestion, lock + enumerate its memories
   * (pushed onto the primary `rows` so they share the receipt), and delete its
   * file_metadata. Returns the object key to remove, or null when the attachment
   * was already gone (idempotent). Foreign-owned members are refused as NotFound
   * — an attachment must belong to the same owner as its carrying email.
   */
  private async cascadeFileSubSource(
    tx: Tx,
    principal: Principal,
    fileKey: string,
    rows: (typeof memory.$inferSelect)[],
  ): Promise<string | null> {
    // A queued/in-flight attachment pipeline run finds its key consumed (or its
    // admission checkpoint serializes on the file_metadata lock taken below).
    if (this.ingestionGuard) {
      await this.ingestionGuard.cancelPending(tx, 'file', fileKey, { waitForRun: false });
    }

    // The attachment's derived memories (FOR UPDATE) — empty is fine for a
    // sub-source (an attachment may have yielded no durable facts).
    const subRows = await tx
      .select()
      .from(memory)
      .where(and(eq(memory.sourceType, 'file'), eq(memory.sourceId, fileKey)))
      .for('update');
    if (subRows.some((r) => r.ownerId !== principal.userId)) {
      throw userError.notFound('source.fileNotFound', 'source file/{{key}} not found', {
        key: fileKey,
      });
    }
    rows.push(...subRows);

    // The attachment's stored file_metadata + object key (locked, then deleted).
    const fileRows = await tx
      .select({ objectKey: fileMetadata.objectKey, ownerId: fileMetadata.ownerId })
      .from(fileMetadata)
      .where(eq(fileMetadata.objectKey, fileKey))
      .for('update');
    const fileRow = fileRows[0];
    if (!fileRow) return null; // already deleted — nothing to remove
    if (fileRow.ownerId !== principal.userId) {
      throw userError.notFound('source.fileNotFound', 'source file/{{key}} not found', {
        key: fileKey,
      });
    }
    await tx.delete(fileMetadata).where(eq(fileMetadata.objectKey, fileKey));
    return fileKey;
  }

  /** Enumerates (and under `lock` FOR UPDATE-locks) the derived memory rows. */
  private async enumerateAndAuthorize(
    tx: Tx,
    principal: Principal,
    sourceType: SourceType,
    sourceId: string,
    opts: { lock: boolean; sourceOwner: string | null },
  ) {
    const baseQuery = tx
      .select()
      .from(memory)
      .where(and(eq(memory.sourceType, sourceType), eq(memory.sourceId, sourceId)));
    const rows = opts.lock ? await baseQuery.for('update') : await baseQuery;

    const notFound = () =>
      userError.notFound('source.notFound', 'source {{sourceType}}/{{sourceId}} not found', {
        sourceType,
        sourceId,
      });
    if (opts.sourceOwner === null && rows.length === 0) throw notFound();
    // Defense in depth: provenance says these derive from the caller's source —
    // any foreign-owned row means corrupted state, and we refuse to touch it.
    if (rows.some((r) => r.ownerId !== principal.userId)) throw notFound();
    return rows;
  }
}

/**
 * Saga steps two and three — the worker leg, one attempt per invocation.
 * Runs inside the idempotentTask transaction keyed
 * (deletion_receipt, <receipt id>, deletion.execute): external deletes first,
 * then confirmation; a failure anywhere rolls back the claim and the
 * confirmation together, and graphile retries with backoff. Exhausted retries
 * park in dead_letter (dashboard-visible) with the receipt still pending.
 */
@Injectable()
export class DeletionExecutor {
  private signer?: InstanceSigner;

  constructor(
    private readonly vectors: MemoryVectorStore,
    private readonly objects: MemoryObjectStore,
    @Inject(INSTANCE_KEY_DIR) private readonly instanceKeyDir: string,
    /** Org resolution for audit stamping (V2.0 item 3.7). Appended LAST on
     * purpose, so no existing wiring or test double shifts position; optional
     * because bare constructions (CLIs, harnesses) have no directory and their
     * entries stay NULL-org, which is the safe direction. */
    @Optional() private readonly directory?: UserDirectory,
  ) {}

  async execute(
    tx: Tx,
    receiptId: string,
  ): Promise<{ alreadyConfirmed: boolean; points: number; objects: number }> {
    const rows = await tx
      .select()
      .from(deletionReceipt)
      .where(eq(deletionReceipt.id, receiptId))
      .for('update');
    const receipt = rows[0];
    if (!receipt) throw new Error(`deletion receipt ${receiptId} not found`);
    if (receipt.status === 'confirmed') return { alreadyConfirmed: true, points: 0, objects: 0 };

    const counts = countsSchema.parse(receipt.countsJson);

    // Step two — external deletion. Absent identifiers are success (spec §11.1)
    // Qdrant point deletion by id ignores missing points; S3 DELETE returns
    // 204 for missing keys. That is what makes retries safe.
    await this.vectors.deletePoints(counts.point_ids);
    for (const key of counts.object_keys) {
      await this.objects.deleteObject(key);
    }

    // Step three — confirmation with chain hash + signature. The advisory
    // lock serializes concurrent confirmations so the chain cannot fork;
    // linkage (not timestamps) defines chain order (see receipt-chain.ts).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('cogeto_deletion_receipt_chain'))`);
    const prevHash = await this.chainTip(tx);
    const now = new Date();
    const iso = now.toISOString();
    const hash = hashReceiptPayload({
      id: receipt.id,
      source_type: receipt.sourceType,
      source_id: receipt.sourceId,
      counts_json: receipt.countsJson,
      signed_at: iso,
      confirmed_at: iso,
      prev_hash: prevHash,
    });
    const signature = (await this.getSigner()).sign(hash);
    await tx
      .update(deletionReceipt)
      .set({ status: 'confirmed', prevHash, hash, signature, signedAt: now, confirmedAt: now })
      .where(eq(deletionReceipt.id, receiptId));
    await writeAudit(tx, {
      actor: 'deletion_saga',
      action: 'deletion_receipt.confirmed',
      entityType: 'deletion_receipt',
      entityId: receiptId,
      detail: {
        points: counts.point_ids.length,
        objects: counts.object_keys.length,
        hash,
      },
      // Receipts are visible to the deletion's actor (0020 ruling 5) — the
      // confirmation entry carries the same owner for the detail gate, and
      // (V2.0 item 3.7) the owner's org, resolved from the directory because
      // this leg runs in the worker with no Principal in scope.
      orgId: (await this.directory?.orgOf(counts.requested_by)) ?? undefined,
      ownerId: counts.requested_by,
    });
    return {
      alreadyConfirmed: false,
      points: counts.point_ids.length,
      objects: counts.object_keys.length,
    };
  }

  /**
   * The current chain tip: the confirmed receipt whose hash no other confirmed
   * receipt links to; GENESIS when the chain is empty. More than one tip means
   * a corrupted chain — refuse to extend it.
   */
  private async chainTip(tx: Tx): Promise<string> {
    const result = await tx.execute(sql`
      SELECT r.hash FROM deletion_receipt r
      WHERE r.status = 'confirmed'
        AND NOT EXISTS (
          SELECT 1 FROM deletion_receipt r2
          WHERE r2.status = 'confirmed' AND r2.prev_hash = r.hash
        )
    `);
    const tips = result.rows as { hash: string }[];
    if (tips.length === 0) return GENESIS_HASH;
    if (tips.length > 1) {
      throw new Error(
        `deletion receipt chain has ${tips.length} tips, refusing to extend a corrupted chain`,
      );
    }
    return tips[0]!.hash;
  }

  private async getSigner(): Promise<InstanceSigner> {
    this.signer ??= await loadInstanceSigner(this.instanceKeyDir);
    return this.signer;
  }
}
