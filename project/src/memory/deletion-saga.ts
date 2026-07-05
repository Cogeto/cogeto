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
import type { Db, InstanceSigner, Tx } from '../infrastructure/index';
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
}

export const SOURCE_DELETIONS = Symbol('SOURCE_DELETIONS');

/** Directory holding the instance signing keypair (decision 0008). */
export const INSTANCE_KEY_DIR = Symbol('INSTANCE_KEY_DIR');

/** counts_json contract — written by the saga, parsed back by the executor. */
const countsSchema = z.object({
  source: z.object({ type: z.string(), id: z.string() }),
  requested_by: z.string(),
  memory_ids: z.array(z.string()),
  memory_count: z.number().int(),
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
      const { rows, fileRow } = await this.loadAndAuthorize(tx, principal, sourceType, sourceId, {
        lock: false,
      });
      return {
        sourceType,
        sourceId,
        memoryCount: rows.length,
        objectCount: fileRow ? 1 : 0,
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
  ): Promise<{ receiptId: string }> {
    const sourceType = assertSourceType(rawSourceType);
    if (!sourceId.trim()) throw new BadRequestException('source id must not be blank');

    return this.db.transaction(async (tx) => {
      const { rows, fileRow, adapter } = await this.loadAndAuthorize(
        tx,
        principal,
        sourceType,
        sourceId,
        { lock: true },
      );

      const memoryIds = rows.map((r) => r.id);

      // Contradiction lift (decision 0010 ruling 8): surviving partners of
      // unresolved relations touching a doomed row are restored to their
      // recorded prior status — an accusation whose evidence is being erased
      // does not stick. The relation rows go with the memories (FK CASCADE).
      const liftedPartners = await liftContradictionsBeforeDeletion(tx, memoryIds, this.vectors);

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
      if (adapter) await adapter.deleteSource(tx, sourceId);

      const counts: ReceiptCounts = {
        source: { type: sourceType, id: sourceId },
        requested_by: principal.userId,
        memory_ids: memoryIds,
        memory_count: memoryIds.length,
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
        },
      });
      return { receiptId };
    });
  }

  /**
   * Enumerates the derived memories and resolves + checks the source owner.
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
    const baseQuery = tx
      .select()
      .from(memory)
      .where(and(eq(memory.sourceType, sourceType), eq(memory.sourceId, sourceId)));
    const rows = opts.lock ? await baseQuery.for('update') : await baseQuery;

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

    const notFound = () => new NotFoundException(`source ${sourceType}/${sourceId} not found`);
    if (sourceOwner === null && rows.length === 0) throw notFound();
    if (sourceOwner !== null && sourceOwner !== principal.userId) throw notFound();
    // Defense in depth: provenance says these derive from the caller's source —
    // any foreign-owned row means corrupted state, and we refuse to touch it.
    if (rows.some((r) => r.ownerId !== principal.userId)) throw notFound();

    return { rows, fileRow, adapter };
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
