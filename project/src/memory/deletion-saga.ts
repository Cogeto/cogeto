import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Principal } from '@cogeto/shared';
import {
  DRIZZLE,
  loadInstanceSigner,
  withTransactionalEnqueue,
  writeAudit,
} from '../infrastructure/index';
import type { Db, DbOrTx, InstanceSigner, Tx } from '../infrastructure/index';
import { deletionReceipt, fileMetadata, memory, sourceTypeEnum } from './persistence/tables';
import type { SourceType } from './persistence/tables';
import { MemoryVectorStore } from './persistence/vector-store';
import { MemoryObjectStore } from './persistence/object-store';
import { hashReceiptPayload, GENESIS_HASH } from './domain/receipt-chain';
import { liftContradictionsBeforeDeletion } from './reconciliation';

/**
 * The deletion saga (§A.7, §B.1) — the ONLY path that hard-deletes memories
 * (§A.1 rule 4). Three steps across three stores:
 *
 *   1. requestSourceDeletion — ONE Postgres transaction: enumerate + delete the
 *      derived memory rows, delete file metadata, delete the source row, write
 *      the receipt (pending), enqueue the external job via the outbox, audit.
 *      If anything fails, the transaction aborts and nothing anywhere changed.
 *   2. DeletionExecutor.execute (worker, idempotent under the receipt id):
 *      delete the enumerated Qdrant points and MinIO objects — absent
 *      identifiers are success, retries re-run both legs safely.
 *   3. Same worker transaction: confirm the receipt with chain hash + instance
 *      signature. The receipt can NEVER read `confirmed` while any enumerated
 *      identifier could still exist: confirmation and the external legs share
 *      one attempt — an external failure rolls the confirmation back.
 *
 * Correctness of enumeration (Addendum §B.1's provability argument): every
 * memory row carries NOT NULL provenance (§A.6) and every write path preserves
 * it — including edit-supersession, which copies the predecessor's provenance
 * onto the successor. So "all memories derived from source S" IS the provenance
 * query, and same-source supersession chains are enumerated in full by
 * construction, with no graph walk needed.
 *
 * Cross-source chains (design decision, recorded in decision 0008): when a
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
 * Port for deleting a source row that lives in another module's table (the
 * exact mirror of ingestion's SourceReader port): the memory module defines
 * it, connector modules implement it, the composition root binds the two —
 * the saga never touches a connector's tables and the module graph stays
 * acyclic (§A.1 rule 2). `file` sources are handled inside this module via
 * file_metadata and need no adapter.
 */
export interface SourceDeletion {
  readonly sourceType: SourceType;
  /** Owner of the source row (locked FOR UPDATE), or null when absent. */
  ownerOf(tx: Tx, sourceId: string): Promise<string | null>;
  /** Deletes the source row inside the saga's enumeration transaction. */
  deleteSource(tx: Tx, sourceId: string): Promise<void>;
  /**
   * Extra artifacts that must be enumerated and removed WITH this source, when a
   * source owns more than its own row + body memories (Session O4 — email). An
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
   * connector's RETAINED sources (issue #62)? The integrity sweep's
   * orphaned-object arm validates objects against file_metadata; connectors
   * that store objects recorded elsewhere (email: raw originals + externalised
   * HTML on email_message) answer here so retained bytes are never mis-flagged
   * as orphans — while a genuinely abandoned object (no row) still is. The
   * probe reads only the connector's own tables (§A.1). Optional — note/chat
   * sources store no objects.
   */
  ownsObjectKeys?(db: DbOrTx, keys: readonly string[]): Promise<string[]>;
}

/**
 * The extra members a source cascades into deletion (Session O4). `objectKeys`
 * are connector-owned MinIO objects deleted directly (the worker leg, absent =
 * success); `fileSubSourceKeys` are `file` source ids whose own memories,
 * file_metadata, and object are erased too. Both feed the ONE receipt.
 */
export interface SourceCascade {
  objectKeys: string[];
  fileSubSourceKeys: string[];
}

export const SOURCE_DELETIONS = Symbol('SOURCE_DELETIONS');

/**
 * Port for cascading DERIVED artifacts (tasks, future derivations) when their
 * memories are erased (decision 0013 ruling 6) — the third of the family
 * after SourceReader and SourceDeletion: memory defines it, the deriving
 * module implements it, composition roots bind it. Implementations delete
 * their own rows inside the enumeration transaction and return the count for
 * the receipt; the FK CASCADE remains as the safety net.
 */
export interface DerivedCascade {
  /** Names the artifact in counts_json (e.g. 'tasks'). */
  readonly artifact: string;
  cascadeForMemories(tx: Tx, memoryIds: string[]): Promise<number>;
  /**
   * Optional: cascade artifacts keyed by the SOURCE being deleted, not its
   * memories (SEC-4). A reply-draft approval derived from an email lives in
   * another module and references the email SOURCE id (not a memory id), so it
   * cannot be reached via `cascadeForMemories`. Runs in the same enumeration
   * transaction and returns the count folded into the receipt.
   */
  cascadeForSource?(tx: Tx, sourceType: string, sourceId: string): Promise<number>;
}

export const DERIVED_CASCADES = Symbol('DERIVED_CASCADES');

/**
 * Cancellation outcome of a source's pending ingestion (QS-5, decision 0024):
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

/** Directory holding the instance signing keypair (decision 0008). */
export const INSTANCE_KEY_DIR = Symbol('INSTANCE_KEY_DIR');

/** counts_json contract — written by the saga, parsed back by the executor. */
const countsSchema = z.object({
  source: z.object({ type: z.string(), id: z.string() }),
  requested_by: z.string(),
  memory_ids: z.array(z.string()),
  memory_count: z.number().int(),
  /** Derived tasks removed with the memories (F3-B, additive — optional so
   * pre-F3 receipts parse unchanged; a count, not an identifier: the sweep
   * ignores it). */
  tasks_removed: z.number().int().optional(),
  /** Assistant chat answers whose stored citations referenced erased memories,
   * redacted to a deletion marker (FIX-1 QS-7, decision 0025; additive —
   * optional so earlier receipts parse unchanged; a count, not an identifier:
   * the sweep ignores it). */
  chat_messages_redacted: z.number().int().optional(),
  /** Reply-draft approvals derived from the deleted email source, whose drafted
   * body (grounded on the erased email + the user's memories) is redacted to a
   * deletion marker (SEC-4; additive — optional so earlier receipts parse
   * unchanged; a count, not an identifier: the sweep ignores it). */
  reply_drafts_redacted: z.number().int().optional(),
  /** Qdrant point id = memory id (§A.4); duplicated for receipt readability. */
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

export interface DeletionPreview {
  sourceType: SourceType;
  sourceId: string;
  memoryCount: number;
  objectCount: number;
}

function assertSourceType(value: string): SourceType {
  if (!(sourceTypeEnum.enumValues as readonly string[]).includes(value)) {
    throw new BadRequestException(`unknown source type '${value}'`);
  }
  return value as SourceType;
}

@Injectable()
export class DeletionSaga {
  private readonly adapters: Map<SourceType, SourceDeletion>;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Optional() @Inject(SOURCE_DELETIONS) adapters: SourceDeletion[] = [],
    /** Payload sync for lifted contradiction partners (0010 ruling 8). */
    @Optional() private readonly vectors?: MemoryVectorStore,
    /** Derived-artifact cascades (0013 ruling 6) — tasks today. */
    @Optional() @Inject(DERIVED_CASCADES) private readonly derivedCascades: DerivedCascade[] = [],
    /** Pending-ingestion cancellation (QS-5, decision 0024) — always bound by
     * the composition roots; optional only for legacy test harnesses. */
    @Optional() @Inject(INGESTION_GUARD) private readonly ingestionGuard?: IngestionGuard,
  ) {
    this.adapters = new Map(adapters.map((a) => [a.sourceType, a]));
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
      }
      return { sourceType, sourceId, memoryCount, objectCount };
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
  ): Promise<{ receiptId: string }> {
    const sourceType = assertSourceType(rawSourceType);
    if (!sourceId.trim()) throw new BadRequestException('source id must not be blank');

    return this.db.transaction(async (tx) => {
      // Lock order (QS-5, decision 0024): source row FIRST, then the ingestion
      // guard, then the memory rows — the same source-before-memories order the
      // pipeline uses, so the two transactions can never deadlock on it.
      const { fileRow, adapter, sourceOwner } = await this.resolveSource(tx, sourceType, sourceId, {
        lock: true,
      });
      if (sourceOwner !== null && sourceOwner !== principal.userId) {
        throw new NotFoundException(`source ${sourceType}/${sourceId} not found`);
      }

      // Cancel pending ingestion BEFORE enumerating (QS-5): a queued pipeline
      // job finds its idempotency key consumed and no-ops; an in-flight run is
      // reported and left to its own admission checkpoint, which serializes
      // against the source-row lock held above. Discard-mode file sources have
      // no row to serialize on, so for them the guard WAITS the run out — the
      // enumeration below then sees whatever that run committed.
      const ingestion = this.ingestionGuard
        ? await this.ingestionGuard.cancelPending(tx, sourceType, sourceId, {
            waitForRun: sourceType === 'file' && !fileRow,
          })
        : null;

      const rows = await this.enumerateAndAuthorize(tx, principal, sourceType, sourceId, {
        lock: true,
        sourceOwner,
      });

      // Cascade members (Session O4 — email): fold the source's extra objects and
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

      const memoryIds = rows.map((r) => r.id);

      // Contradiction lift (decision 0010 ruling 8): surviving partners of
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
      let tasksRemoved = 0;
      let chatMessagesRedacted = 0;
      let replyDraftsRedacted = 0;
      for (const cascade of this.derivedCascades) {
        const removed = await cascade.cascadeForMemories(tx, memoryIds);
        if (cascade.artifact === 'tasks') tasksRemoved += removed;
        // QS-7 (decision 0025): assistant answers that cited erased memories
        // are redacted to a deletion marker by the chat cascade; the receipt
        // counts them so the erasure claim is complete, not just row-deep.
        if (cascade.artifact === 'chat_messages') chatMessagesRedacted += removed;
        // SEC-4: reply-draft approvals derived from THIS source (by source id,
        // not memory id) — their drafted body is redacted so a "provably
        // deleted" receipt no longer over-claims while the draft survives.
        if (cascade.cascadeForSource) {
          const redacted = await cascade.cascadeForSource(tx, sourceType, sourceId);
          if (cascade.artifact === 'reply_drafts') replyDraftsRedacted += redacted;
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
      if (sourceType === 'file' && fileRow) {
        await tx.delete(fileMetadata).where(eq(fileMetadata.objectKey, sourceId));
        objectKeys.push(sourceId);
      }
      // The source's cascaded objects (email raw + HTML + attachment objects),
      // deduped so a key can never be double-listed in the receipt.
      for (const key of cascadeObjectKeys) if (!objectKeys.includes(key)) objectKeys.push(key);
      if (adapter) await adapter.deleteSource(tx, sourceId);

      const counts: ReceiptCounts = {
        source: { type: sourceType, id: sourceId },
        requested_by: principal.userId,
        memory_ids: memoryIds,
        memory_count: memoryIds.length,
        tasks_removed: tasksRemoved,
        chat_messages_redacted: chatMessagesRedacted,
        reply_drafts_redacted: replyDraftsRedacted,
        point_ids: memoryIds,
        object_keys: objectKeys,
        superseded_by_nulled: nulledPointers,
        enumerated_at: new Date().toISOString(),
      };
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
        actor: `user:${principal.userId}`,
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
          // The QS-5 cancellation trace: how pending ingestion was resolved.
          ingestionCancellation: ingestion,
        },
        orgId: principal.orgId,
        ownerId: principal.userId,
      });
      return { receiptId };
    });
  }

  /**
   * Enumerates the derived memories and resolves + checks the source owner —
   * the preview path (read-only). The deletion path composes the same two
   * halves directly so the ingestion guard can run between them (QS-5).
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
      throw new NotFoundException(`source ${sourceType}/${sourceId} not found`);
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
    let sourceOwner: string | null = null;

    if (sourceType === 'file') {
      const fileQuery = tx.select().from(fileMetadata).where(eq(fileMetadata.objectKey, sourceId));
      fileRow = (opts.lock ? await fileQuery.for('update') : await fileQuery)[0];
      sourceOwner = fileRow?.ownerId ?? null;
    } else {
      adapter = this.adapters.get(sourceType);
      if (!adapter) {
        throw new BadRequestException(
          `no deletion adapter registered for source type '${sourceType}'`,
        );
      }
      sourceOwner = await adapter.ownerOf(tx, sourceId);
    }
    return { fileRow, adapter, sourceOwner };
  }

  /**
   * Cascades one attachment `file` sub-source inside the enumeration transaction
   * (Session O4): cancel its pending ingestion, lock + enumerate its memories
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
      throw new NotFoundException(`source file/${fileKey} not found`);
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
      throw new NotFoundException(`source file/${fileKey} not found`);
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

    const notFound = () => new NotFoundException(`source ${sourceType}/${sourceId} not found`);
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

    // Step two — external deletion. Absent identifiers are success (§A.7):
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
      // confirmation entry carries the same owner for the detail gate.
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
        `deletion receipt chain has ${tips.length} tips — refusing to extend a corrupted chain`,
      );
    }
    return tips[0]!.hash;
  }

  private async getSigner(): Promise<InstanceSigner> {
    this.signer ??= await loadInstanceSigner(this.instanceKeyDir);
    return this.signer;
  }
}
