import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lte } from 'drizzle-orm';
import type { PassportExportDto } from '@cogeto/shared';
import { PASSPORT_VERSION } from '@cogeto/shared';
import { DRIZZLE } from '../infrastructure/index';
import type { Db, Tx } from '../infrastructure/index';
import { passportExport } from './persistence/tables';
import type { PassportExportRow } from './persistence/tables';

/** The export job type — a worker task. Underscore identifier: graphile's
 * crontab parser rejects dots (a dotted name crashes the worker on boot). */
export const PASSPORT_EXPORT_JOB_TYPE = 'passport_export';
/** The recurring retention pass that expires short-lived export artifacts. */
export const PASSPORT_RETENTION_JOB_TYPE = 'passport_retention';
/** Hourly retention sweep (spec §11.4): deletes export objects past their expiry. */
export const PASSPORT_RETENTION_CRONTAB = `30 * * * * ${PASSPORT_RETENTION_JOB_TYPE}`;

/**
 * The passport export ledger (spec §11.4) — module-private CRUD over
 * the request/status rows. Owner-scoping is enforced on every read: an export
 * row is only ever returned to the user who created it.
 */
@Injectable()
export class PassportExportStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Create a pending request inside the caller's transaction (with the enqueue). */
  async createInTx(
    tx: Tx,
    userId: string,
    orgId: string | undefined,
    includeOriginals: boolean,
  ): Promise<PassportExportRow> {
    const [row] = await tx
      .insert(passportExport)
      .values({
        userId,
        orgId: orgId ?? null,
        passportVersion: PASSPORT_VERSION,
        includeOriginals,
      })
      .returning();
    return row!;
  }

  /** The worker reads the full row (no owner gate — the id came from the job). */
  async getById(id: string): Promise<PassportExportRow | null> {
    const rows = await this.db
      .select()
      .from(passportExport)
      .where(eq(passportExport.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Owner-gated read for the status/download endpoints. */
  async getForOwner(userId: string, id: string): Promise<PassportExportRow | null> {
    const rows = await this.db
      .select()
      .from(passportExport)
      .where(and(eq(passportExport.id, id), eq(passportExport.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async listForOwner(userId: string): Promise<PassportExportRow[]> {
    return this.db
      .select()
      .from(passportExport)
      .where(eq(passportExport.userId, userId))
      .orderBy(desc(passportExport.createdAt))
      .limit(50);
  }

  /**
   * Publish a finished export, but ONLY if it is still `pending`.
   *
   * Security audit 2.0 SEC-8: a source deletion expires the owner's in-flight
   * exports inside the enumeration transaction, because the worker assembled
   * them from reads that may already have seen the doomed rows. A `pending` row
   * has no object key yet, so nothing joins the receipt's `object_keys` and the
   * integrity sweep never learns about it. An unconditional update here would
   * then flip that expired row back to `ready` with a live key, leaving a
   * downloadable archive of provably erased content that no receipt references.
   * The status guard closes that window: on a lost race the update matches no
   * row, the caller deletes the object it just wrote, and the export stays
   * expired. Returns whether the row was published.
   */
  async markReady(
    id: string,
    objectKey: string,
    sizeBytes: number,
    readyAt: Date,
    expiresAt: Date,
  ): Promise<boolean> {
    const rows = await this.db
      .update(passportExport)
      .set({ status: 'ready', objectKey, sizeBytes, readyAt, expiresAt })
      .where(and(eq(passportExport.id, id), eq(passportExport.status, 'pending')))
      .returning({ id: passportExport.id });
    return rows.length > 0;
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db
      .update(passportExport)
      .set({ status: 'failed', error: error.slice(0, 500) })
      .where(eq(passportExport.id, id));
  }

  /** Ready exports past their expiry — the retention job's work list. */
  async listExpired(now: Date, limit = 100): Promise<PassportExportRow[]> {
    return this.db
      .select()
      .from(passportExport)
      .where(and(eq(passportExport.status, 'ready'), lte(passportExport.expiresAt, now)))
      .limit(limit);
  }

  async markExpired(id: string): Promise<void> {
    await this.db
      .update(passportExport)
      .set({ status: 'expired', objectKey: null })
      .where(eq(passportExport.id, id));
  }
}

/** Row → API DTO. `filename` is derived from the creation date. */
export function toExportDto(row: PassportExportRow): PassportExportDto {
  const day = row.createdAt.toISOString().slice(0, 10);
  return {
    id: row.id,
    status: row.status as PassportExportDto['status'],
    passportVersion: row.passportVersion,
    includeOriginals: row.includeOriginals,
    filename: `cogeto-passport-${day}.zip`,
    sizeBytes: row.sizeBytes ?? null,
    createdAt: row.createdAt.toISOString(),
    readyAt: row.readyAt?.toISOString() ?? null,
    error: row.error ?? null,
  };
}
