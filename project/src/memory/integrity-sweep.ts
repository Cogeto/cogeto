import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNotNull, notInArray, or, sql } from 'drizzle-orm';
import { DEFUNCT_SOURCE_TYPES, isRegisteredSourceType, SOURCE_TYPE_KEYS } from '@cogeto/shared';
import {
  DRIZZLE,
  loadInstancePublicKey,
  readAuditEntries,
  writeAudit,
} from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { deletionReceipt, fileMetadata, integrityAlert, memory } from './persistence/tables';
import type { SourceType } from './persistence/tables';
import { MemoryVectorStore } from './persistence/vector-store';
import { MemoryObjectStore } from './persistence/object-store';
import { INSTANCE_KEY_DIR, parseReceiptCounts } from './deletion-saga';
import { readEmbeddingIndexState, REBUILD_COLLECTION_PREFIX } from './embedding-index';
import type { SourceDeletion } from './deletion-saga';
import { verifyChain } from './domain/receipt-chain';
import type { ConfirmedReceipt } from './domain/receipt-chain';

/**
 * The nightly reconciliation sweep (spec §11.1 step 4): for every CONFIRMED receipt,
 * re-derive the enumerated identifiers from counts_json and verify absence —
 * no memory rows with those ids, no Qdrant points, no objects at those keys.
 * A hit means the saga's promise was broken after the fact (restored backup,
 * manual writes, index rebuild gone wrong) — an integrity violation, never
 * auto-repaired: it becomes a persistent alert row, surfaces in /api/health
 * and the System view, and stays until the owner investigates.
 *
 * Every run also re-verifies the receipt hash chain. Alert writes are
 * idempotent (dedupe unique index): the same violation found nightly stays
 * one row, so re-runs never multiply alerts.
 */

// Underscore, not a dot: graphile's crontab parser rejects dots in task names.
export const SWEEP_JOB_TYPE = 'deletion_sweep';
/** 03:00 every night, instance-local time (graphile-worker crontab). */
export const SWEEP_CRONTAB = `0 3 * * * ${SWEEP_JOB_TYPE}`;

export type AlertKind =
  | 'memory_row_present'
  | 'qdrant_point_present'
  | 'object_present'
  | 'chain_broken'
  /**
   * A memory row whose provenance no longer resolves : either its (source_type, source_id) matches a confirmed receipt's
   * source but the id is not in that receipt (a post-receipt resurrection), or
   * its source row no longer exists. Either way the "no orphans, ever"
   * invariant is broken — an integrity violation, never auto-repaired.
   */
  | 'orphaned_memory'
  /**
   * An object in the bucket with no file_metadata row and no staging excuse
   * PII bytes outside any receipt's reach — e.g. a
   * failed compensating delete after an aborted upload. Never auto-repaired
   * (deleting bytes is the saga's monopoly): the owner investigates.
   */
  | 'orphaned_object'
  /**
   * A live memory row whose Qdrant payload disagrees on a gate-relevant field
   * a payload write that survived a failed commit.
   * Retrieval re-gates every hit through Postgres, so this is a RECALL/
   * consistency defect, never a leak. Self-healed by a targeted payload
   * re-upsert; the alert records that it happened.
   */
  | 'payload_mismatch';

export interface SweepReport {
  receiptsChecked: number;
  identifiersChecked: number;
  /** Bucket objects examined by the orphan-object arm. */
  objectsScanned: number;
  /** Live rows compared against their Qdrant payloads. */
  payloadsChecked: number;
  /** Stale payloads re-upserted by the self-heal. */
  payloadsHealed: number;
  /** Alerts newly written this run (0 on a re-run over known violations). */
  newAlerts: number;
  /** All alert rows on record after this run. */
  openAlerts: number;
  /**
   * Stray rebuild collections dropped (V2.4 item 7.1 second half): a crash
   * between a rebuild's cancellation and its cleanup can leave a
   * `memories_r*` collection consuming storage. Unlike the deletion arms this
   * one REPAIRS: the artifact is index hygiene, not evidence — every
   * promised-deleted identifier was dual-deleted from it while it lived, so
   * dropping it only makes deletion more complete.
   */
  strayCollectionsDropped: number;
  /** Every space's chain verifies (docs/features/spaces.md: one chain per
   * space). On failure, `chainError` names each failing space with its
   * underlying error. */
  chainOk: boolean;
  chainError?: string;
}

/**
 * The sweep's collaborators and tuning, by NAME (V2.0 item 3.6 part 4): the
 * source adapters joined the bag so no construction site passes them by
 * position. Built by MemoryModule from the SOURCE_DELETIONS port; tests name
 * their fields; production defaults apply when absent.
 */
export interface SweepOptions {
  /** Source-row existence probes for the orphan arm — the same adapters the
   * saga binds; file sources are covered receipt-side. */
  sourceAdapters?: SourceDeletion[];
  /**
   * Objects younger than this are never orphans: stored-mode uploads
   * PUT the bytes BEFORE the metadata transaction commits, and staging
   * objects have a 15-minute cleanup backstop — 60 minutes comfortably clears
   * both without masking real residue for more than one night.
   */
  objectGraceMinutes?: number;
}

export const SWEEP_OPTIONS = Symbol('SWEEP_OPTIONS');

const DEFAULT_OBJECT_GRACE_MINUTES = 60;
/** page size: the full scan runs in id-keyset pages of this many rows. */
const PAYLOAD_PAGE_SIZE = 500;

export interface IntegrityAlertRecord {
  id: string;
  receiptId: string | null;
  kind: string;
  detail: string;
  detectedAt: string;
}

export interface IntegrityStatus {
  lastSweepAt: string | null;
  lastReport: SweepReport | null;
  openAlerts: number;
}

@Injectable()
export class IntegritySweep {
  private readonly sourceAdapters: Map<SourceType, SourceDeletion>;

  private readonly options?: SweepOptions;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly vectors: MemoryVectorStore,
    private readonly objects: MemoryObjectStore,
    @Inject(INSTANCE_KEY_DIR) private readonly instanceKeyDir: string,
    /** Every optional collaborator, by NAME — see SweepOptions. */
    @Optional() @Inject(SWEEP_OPTIONS) options?: SweepOptions,
  ) {
    this.options = options;
    this.sourceAdapters = new Map((options?.sourceAdapters ?? []).map((a) => [a.sourceType, a]));
  }

  async run(log?: (message: string) => void): Promise<SweepReport> {
    const confirmed = await this.db
      .select()
      .from(deletionReceipt)
      .where(eq(deletionReceipt.status, 'confirmed'));

    const found: { receiptId: string | null; kind: AlertKind; detail: string }[] = [];
    let identifiersChecked = 0;

    for (const receipt of confirmed) {
      const counts = parseReceiptCounts(receipt.countsJson);
      identifiersChecked +=
        counts.memory_ids.length + counts.point_ids.length + counts.object_keys.length;

      if (counts.memory_ids.length > 0) {
        const rows = await this.db
          .select({ id: memory.id })
          .from(memory)
          .where(inArray(memory.id, counts.memory_ids));
        for (const row of rows) {
          found.push({ receiptId: receipt.id, kind: 'memory_row_present', detail: row.id });
        }
      }
      const points = await this.vectors.retrievePayloads(counts.point_ids);
      for (const pointId of points.keys()) {
        found.push({ receiptId: receipt.id, kind: 'qdrant_point_present', detail: pointId });
      }
      for (const key of counts.object_keys) {
        if (await this.objects.objectExists(key)) {
          found.push({ receiptId: receipt.id, kind: 'object_present', detail: key });
        }
      }

      // Orphan arm, receipt side: a receipted source is
      // provably deleted, so ANY memory row whose provenance still points at
      // it — including ids minted after enumeration by a racing pipeline run —
      // is a resurrection. Ids in the receipt are covered above; this catches
      // the rest. Works for every source type, discard-mode files included.
      const resurrectedWhere = and(
        eq(memory.sourceType, receipt.sourceType),
        eq(memory.sourceId, receipt.sourceId),
      );
      const resurrected = await this.db
        .select({ id: memory.id })
        .from(memory)
        .where(
          counts.memory_ids.length > 0
            ? and(resurrectedWhere, notInArray(memory.id, counts.memory_ids))
            : resurrectedWhere,
        );
      for (const row of resurrected) {
        found.push({ receiptId: receipt.id, kind: 'orphaned_memory', detail: row.id });
        identifiersChecked += 1;
      }
    }

    // Orphan arm, source side: memories whose
    // source row no longer exists — historical residue and any deletion path
    // that bypassed provenance. Probed through the saga's SourceDeletion
    // adapters (row-backed types only; 'file' is intentionally absent: a
    // discard-mode upload legitimately has memories and no row, so file
    // resurrections are detected receipt-side above).
    found.push(...(await this.findOrphanedMemories()));

    // Defunct-provenance arm: a source_type the product no
    // longer produces is a KNOWN value, never an error — but a memory still
    // carrying one has provenance pointing at a table that no longer exists,
    // which is precisely an orphan. Migration 0035 makes this impossible going
    // forward (it refuses to drop while any survive); this arm is the standing
    // proof, so the residue can never rot silently.
    found.push(...(await this.findDefunctProvenance()));

    // Orphan-object arm: every bucket object must be a
    // file_metadata row's bytes or a staging object inside its cleanup window.
    const orphanObjects = await this.findOrphanedObjects();
    found.push(...orphanObjects.alerts);

    // Payload-consistency arm: live rows vs their
    // Qdrant payload copies, self-healed by targeted re-upsert.
    const payloads = await this.reconcilePayloads();
    found.push(...payloads.alerts);

    // Stray-rebuild-collection arm (V2.4 item 7.1 second half): a rebuild
    // collection no state references is a crash leftover; drop it.
    const strayCollectionsDropped = await this.dropStrayRebuildCollections(log);

    // Chain verification is PER SPACE (docs/features/spaces.md section 5 as
    // amended): each space owns its own chain with its own genesis and tip,
    // so the frozen verifyChain walk runs once over each space's receipts.
    // One flat walk over a multi-space ledger would trip the fork detector on
    // the second space's genesis, which is exactly why the grouping exists.
    const publicKey = await loadInstancePublicKey(this.instanceKeyDir);
    const bySpace = new Map<string, ConfirmedReceipt[]>();
    for (const row of confirmed) {
      const receipts = bySpace.get(row.spaceId) ?? [];
      receipts.push(toConfirmedReceipt(row));
      bySpace.set(row.spaceId, receipts);
    }
    const chainErrors: string[] = [];
    for (const [spaceId, receipts] of bySpace) {
      const chain = verifyChain(receipts, publicKey);
      if (!chain.ok) {
        const detail = `space ${spaceId}: ${chain.error ?? 'unknown'}`;
        chainErrors.push(detail);
        found.push({ receiptId: null, kind: 'chain_broken', detail });
      }
    }
    const chainOk = chainErrors.length === 0;

    let newAlerts = 0;
    for (const alert of found) {
      const inserted = await this.db
        .insert(integrityAlert)
        .values(alert)
        .onConflictDoNothing()
        .returning({ id: integrityAlert.id });
      newAlerts += inserted.length;
    }
    const openAlerts = await this.countAlerts();

    const report: SweepReport = {
      receiptsChecked: confirmed.length,
      identifiersChecked,
      objectsScanned: orphanObjects.scanned,
      payloadsChecked: payloads.checked,
      payloadsHealed: payloads.healed,
      newAlerts,
      openAlerts,
      strayCollectionsDropped,
      chainOk,
      ...(chainErrors.length > 0 ? { chainError: chainErrors.join('; ') } : {}),
    };
    // The sweep's own ledger entry — status reads the latest of these.
    // No org, deliberately (V2.0 item 3.7): the sweep is instance-wide
    // operator integrity with no owner and no org, and NULL is the contract's
    // marker for exactly that.
    await writeAudit(this.db, {
      actor: 'integrity_sweep',
      action: 'sweep.completed',
      entityType: 'integrity_sweep',
      entityId: randomUUID(),
      detail: { ...report },
    });
    if (openAlerts > 0 || !chainOk) {
      // Loud by contract: an integrity violation must never scroll by quietly.
      const message = `INTEGRITY VIOLATION: ${openAlerts} alert(s) on record, chain ${chainOk ? 'ok' : `BROKEN (${chainErrors.join('; ')})`}`;
      (log ?? console.error)(message);
    }
    return report;
  }

  /** DB-only (cheap enough for the health poll): last run + open alert count. */
  async status(): Promise<IntegrityStatus> {
    const [last] = await readAuditEntries(this.db, {
      actions: ['sweep.completed'],
      limit: 1,
    });
    return {
      lastSweepAt: last?.createdAt.toISOString() ?? null,
      lastReport: (last?.detail as SweepReport | null) ?? null,
      openAlerts: await this.countAlerts(),
    };
  }

  async listAlerts(limit = 50): Promise<IntegrityAlertRecord[]> {
    const rows = await this.db
      .select()
      .from(integrityAlert)
      .orderBy(desc(integrityAlert.detectedAt))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      receiptId: row.receiptId,
      kind: row.kind,
      detail: row.detail,
      detectedAt: row.detectedAt.toISOString(),
    }));
  }

  /**
   * Rebuild collections nothing references (V2.4 item 7.1 second half). A
   * managed rebuild's target lives under the `memories_r` prefix and is named
   * on the state row for its whole legitimate life — as target while running,
   * as active after the switch, as retired during the drop grace. A prefixed
   * collection the state does not name is a crash leftover consuming storage
   * indefinitely, and this arm drops it. Repair is safe here, uniquely: the
   * artifact carries no evidence (deletions were dual-applied to it while it
   * lived), and destroying it can only make erasure more complete.
   */
  private async dropStrayRebuildCollections(log?: (message: string) => void): Promise<number> {
    const state = await readEmbeddingIndexState(this.db);
    const referenced = new Set(
      [state.activeCollection, state.targetCollection, state.retiredCollection].filter(
        (name): name is string => !!name,
      ),
    );
    const strays = (await this.vectors.listCollectionNames()).filter(
      (name) => name.startsWith(REBUILD_COLLECTION_PREFIX) && !referenced.has(name),
    );
    for (const name of strays) {
      await this.vectors.view(name, 1).deleteCollectionIfExists();
      log?.(`dropped stray rebuild collection ${name}`);
    }
    return strays.length;
  }

  /**
   * Memories whose `source_type` is defunct — their source
   * table is gone, so their provenance cannot resolve. Expected to return
   * nothing forever; if it ever does not, the erase-before-drop ordering was
   * bypassed and the rows need the deletion saga.
   *
   * Since migration 0040 the column is text and the vocabulary lives in the
   * source-type registry (spec §15.3), so this arm also covers what the
   * database enum used to make impossible: a row whose `source_type` the
   * registry does not know at all (only reachable by a manual write). Both
   * are provenance that cannot resolve; the defunct case stays distinguished
   * in the alert copy because a defunct value is a KNOWN value, never an
   * unrecognised one.
   */
  private async findDefunctProvenance(): Promise<
    { receiptId: string | null; kind: AlertKind; detail: string }[]
  > {
    const rows = await this.db
      .select({ id: memory.id, sourceType: memory.sourceType })
      .from(memory)
      .where(
        or(
          inArray(memory.sourceType, [...DEFUNCT_SOURCE_TYPES]),
          notInArray(memory.sourceType, SOURCE_TYPE_KEYS),
        ),
      )
      .limit(200);
    return rows.map((row) => ({
      receiptId: null,
      kind: 'orphaned_memory' as AlertKind,
      detail: isRegisteredSourceType(row.sourceType)
        ? `${row.id} (defunct source_type '${row.sourceType}')`
        : `${row.id} (unregistered source_type '${row.sourceType}')`,
    }));
  }

  /**
   * Source-side orphan detection. For each adapter-backed
   * source type: group live memories by (source_type, source_id), probe the
   * source row through the adapter, and on a miss RE-READ the memories in the
   * same transaction — the saga deletes memories and their source atomically,
   * so rows that survive the re-read while the source is gone are genuine
   * orphans, not a mid-delete snapshot artifact. O(distinct sources) nightly;
   * the adapter's FOR UPDATE lock is per-row and released per iteration.
   */
  private async findOrphanedMemories(): Promise<
    { receiptId: string | null; kind: AlertKind; detail: string }[]
  > {
    const orphans: { receiptId: string | null; kind: AlertKind; detail: string }[] = [];
    const adapterTypes = [...this.sourceAdapters.keys()];
    if (adapterTypes.length === 0) return orphans;

    const groups = await this.db
      .selectDistinct({ sourceType: memory.sourceType, sourceId: memory.sourceId })
      .from(memory)
      .where(inArray(memory.sourceType, adapterTypes));

    for (const group of groups) {
      const adapter = this.sourceAdapters.get(group.sourceType)!;
      const orphanIds = await this.db.transaction(async (tx) => {
        if ((await adapter.ownerOf(tx, group.sourceId)) !== null) return [];
        const rows = await tx
          .select({ id: memory.id })
          .from(memory)
          .where(and(eq(memory.sourceType, group.sourceType), eq(memory.sourceId, group.sourceId)));
        return rows.map((r) => r.id);
      });
      for (const id of orphanIds) {
        orphans.push({ receiptId: null, kind: 'orphaned_memory', detail: id });
      }
    }
    return orphans;
  }

  /**
   * objects in the bucket unaccounted for by
   * file_metadata. Anything younger than the grace window is skipped — the
   * stored-upload PUT lands before its metadata transaction commits, and
   * staging objects live legitimately until the 15-minute cleanup backstop.
   * Past the window: a staging key means the discard cleanup never ran; any
   * other key with no metadata row means a failed compensating delete (or a
   * write outside the upload path) left PII bytes no receipt can ever cover.
   * Detection only — deleting bytes stays the saga's monopoly (spec §11.1).
   */
  private async findOrphanedObjects(): Promise<{
    scanned: number;
    alerts: { receiptId: string | null; kind: AlertKind; detail: string }[];
  }> {
    const alerts: { receiptId: string | null; kind: AlertKind; detail: string }[] = [];
    const objects = await this.objects.listObjects();
    const graceMinutes = this.options?.objectGraceMinutes ?? DEFAULT_OBJECT_GRACE_MINUTES;
    const cutoff = new Date(Date.now() - graceMinutes * 60_000);

    const aged = objects
      .filter((o) => o.lastModified < cutoff)
      // Passport export objects are backed by the passport
      // module's own ledger and retention, not file_metadata; skip them here so
      // a legitimate short-lived export is never mis-flagged as an orphan.
      .filter((o) => o.key.split('/')[2] !== 'exports');
    const stagingKeys = aged.filter((o) => o.key.split('/')[2] === 'staging');
    const durableKeys = aged.filter((o) => o.key.split('/')[2] !== 'staging');

    const known = new Set<string>();
    for (let i = 0; i < durableKeys.length; i += 500) {
      const batch = durableKeys.slice(i, i + 500).map((o) => o.key);
      const rows = await this.db
        .select({ objectKey: fileMetadata.objectKey })
        .from(fileMetadata)
        .where(inArray(fileMetadata.objectKey, batch));
      for (const row of rows) known.add(row.objectKey);
      // Connector-owned objects recorded outside file_metadata
      // retained email raw originals / externalised HTML live on email_message.
      // Ask each adapter which keys its live rows own — an abandoned object
      // with no row matches nothing and is still flagged.
      for (const adapter of this.sourceAdapters.values()) {
        if (!adapter.ownsObjectKeys) continue;
        for (const key of await adapter.ownsObjectKeys(this.db, batch)) known.add(key);
      }
    }

    for (const { key } of stagingKeys) {
      alerts.push({
        receiptId: null,
        kind: 'orphaned_object',
        detail: `${key}: staging object outlived its cleanup window; original bytes not erased`,
      });
    }
    for (const { key } of durableKeys) {
      if (known.has(key)) continue;
      alerts.push({
        receiptId: null,
        kind: 'orphaned_object',
        detail: `${key}: object present with no owning record (file_metadata or a connector's retained source); bytes outside any receipt`,
      });
    }
    return { scanned: objects.length, alerts };
  }

  /**
   * compares every embedded live row's gate-relevant
   * fields (owner_id, scope, status, sensitive) against its Qdrant payload
   * and re-upserts the payload on mismatch (idempotent — the same targeted
   * setPayload the write paths use). FULL scan, not a sample: the cost is one
   * batched point-retrieve per 500 rows nightly — trivial at v1 scale (even
   * 100k memories is 200 Qdrant calls) — and a sample cannot promise the
   * "detected within one sweep cycle" bar. Retrieval re-gates every hit
   * through Postgres, so a stale payload distorts RECALL, never visibility —
   * the alert copy says so, to keep the severity honest.
   */
  private async reconcilePayloads(): Promise<{
    checked: number;
    healed: number;
    alerts: { receiptId: string | null; kind: AlertKind; detail: string }[];
  }> {
    const alerts: { receiptId: string | null; kind: AlertKind; detail: string }[] = [];
    let checked = 0;
    let healed = 0;
    let afterId: string | null = null;

    for (;;) {
      const page = await this.db
        .select({
          id: memory.id,
          ownerId: memory.ownerId,
          scope: memory.scope,
          status: memory.status,
          sensitive: memory.sensitive,
          spaceId: memory.spaceId,
          validUntil: memory.validUntil,
        })
        .from(memory)
        .where(
          afterId === null
            ? isNotNull(memory.embeddingModel)
            : and(isNotNull(memory.embeddingModel), gt(memory.id, afterId)),
        )
        .orderBy(asc(memory.id))
        .limit(PAYLOAD_PAGE_SIZE);
      if (page.length === 0) break;
      afterId = page[page.length - 1]!.id;
      checked += page.length;

      const payloads = await this.vectors.retrievePayloads(page.map((r) => r.id));
      for (const row of page) {
        const payload = payloads.get(row.id);
        if (!payload) {
          // An embedded row with no point: rebuildable state (spec §4.2) — reindex
          // restores it; recall-only, so no self-heal here (no vector to write).
          alerts.push({
            receiptId: null,
            kind: 'payload_mismatch',
            detail:
              `${row.id}: indexed point missing; run reindex. Recall-only: ` +
              'retrieval re-gates through Postgres, this is not a leak',
          });
          continue;
        }
        const stale: string[] = [];
        if (payload['owner_id'] !== row.ownerId) stale.push('owner_id');
        if (payload['scope'] !== row.scope) stale.push('scope');
        if (payload['status'] !== row.status) stale.push('status');
        if (payload['sensitive'] !== row.sensitive) stale.push('sensitive');
        // The space is a gate field like the others (docs/features/spaces.md),
        // so a stale payload copy is caught and healed within one cycle.
        if (payload['space_id'] !== row.spaceId) stale.push('space_id');
        if (stale.length === 0) continue;

        await this.vectors.setPayload(row.id, {
          owner_id: row.ownerId,
          scope: row.scope,
          status: row.status,
          sensitive: row.sensitive,
          space_id: row.spaceId,
          valid_until: row.validUntil?.toISOString() ?? null,
        });
        healed += 1;
        alerts.push({
          receiptId: null,
          kind: 'payload_mismatch',
          detail:
            `${row.id}: stale index payload (${stale.join(', ')}); self-healed by ` +
            're-upsert. Recall/consistency only, not a leak: retrieval re-gates ' +
            'every hit through Postgres',
        });
      }
    }
    return { checked, healed, alerts };
  }

  private async countAlerts(): Promise<number> {
    const rows = await this.db.select({ n: sql<number>`count(*)::int` }).from(integrityAlert);
    return rows[0]?.n ?? 0;
  }
}

function toConfirmedReceipt(row: typeof deletionReceipt.$inferSelect): ConfirmedReceipt {
  return {
    id: row.id,
    source_type: row.sourceType,
    source_id: row.sourceId,
    counts_json: row.countsJson,
    signed_at: row.signedAt?.toISOString() ?? '',
    confirmed_at: row.confirmedAt?.toISOString() ?? '',
    prev_hash: row.prevHash ?? '',
    hash: row.hash ?? '',
    signature: row.signature ?? '',
  };
}
