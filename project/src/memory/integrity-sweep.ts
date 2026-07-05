import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { auditLog, DRIZZLE, loadInstancePublicKey, writeAudit } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { deletionReceipt, integrityAlert, memory } from './persistence/tables';
import { MemoryVectorStore } from './persistence/vector-store';
import { MemoryObjectStore } from './persistence/object-store';
import { INSTANCE_KEY_DIR, parseReceiptCounts } from './deletion-saga';
import { verifyChain } from './domain/receipt-chain';
import type { ConfirmedReceipt } from './domain/receipt-chain';

/**
 * The nightly reconciliation sweep (§A.7 step 4): for every CONFIRMED receipt,
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
  'memory_row_present' | 'qdrant_point_present' | 'object_present' | 'chain_broken';

export interface SweepReport {
  receiptsChecked: number;
  identifiersChecked: number;
  /** Alerts newly written this run (0 on a re-run over known violations). */
  newAlerts: number;
  /** All alert rows on record after this run. */
  openAlerts: number;
  chainOk: boolean;
  chainError?: string;
}

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
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly vectors: MemoryVectorStore,
    private readonly objects: MemoryObjectStore,
    @Inject(INSTANCE_KEY_DIR) private readonly instanceKeyDir: string,
  ) {}

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
    }

    const chain = verifyChain(
      confirmed.map(toConfirmedReceipt),
      await loadInstancePublicKey(this.instanceKeyDir),
    );
    if (!chain.ok) {
      found.push({ receiptId: null, kind: 'chain_broken', detail: chain.error ?? 'unknown' });
    }

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
      newAlerts,
      openAlerts,
      chainOk: chain.ok,
      ...(chain.error ? { chainError: chain.error } : {}),
    };
    // The sweep's own ledger entry — status() reads the latest of these.
    await writeAudit(this.db, {
      actor: 'integrity_sweep',
      action: 'sweep.completed',
      entityType: 'integrity_sweep',
      entityId: randomUUID(),
      detail: { ...report },
    });
    if (openAlerts > 0 || !chain.ok) {
      // Loud by contract: an integrity violation must never scroll by quietly.
      const message = `INTEGRITY VIOLATION: ${openAlerts} alert(s) on record, chain ${chain.ok ? 'ok' : `BROKEN (${chain.error})`}`;
      (log ?? console.error)(message);
    }
    return report;
  }

  /** DB-only (cheap enough for the health poll): last run + open alert count. */
  async status(): Promise<IntegrityStatus> {
    const [last] = await this.db
      .select({ createdAt: auditLog.createdAt, detail: auditLog.detailJson })
      .from(auditLog)
      .where(eq(auditLog.action, 'sweep.completed'))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
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
