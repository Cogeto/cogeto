import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, lte, ne } from 'drizzle-orm';
import type { FindingsReportDto, ReportProgressDto, ReportScopeDto } from '@cogeto/shared';
import { FINDINGS_REPORT_VERSION } from '@cogeto/shared';
import { DRIZZLE } from '../infrastructure/index';
import type { Db, Tx } from '../infrastructure/index';
import { findingsReport } from './persistence/tables';
import type { FindingsReportRow } from './persistence/tables';

/**
 * The findings-run ledger (V2.3 item 6.2) — module-private CRUD. Owner-scoping
 * is enforced on every read surface: a run row is only ever returned to the
 * user who requested it. The row outlives its artifacts: expiry nulls the
 * object keys, never the row, because the delta view compares against it.
 */
@Injectable()
export class ReportStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Create a pending run inside the caller's transaction (with the enqueue). */
  async createInTx(
    tx: Tx,
    userId: string,
    orgId: string | undefined,
    scope: ReportScopeDto,
    scopeKey: string,
    locale: string,
  ): Promise<FindingsReportRow> {
    const [row] = await tx
      .insert(findingsReport)
      .values({
        userId,
        orgId: orgId ?? null,
        reportVersion: FINDINGS_REPORT_VERSION,
        locale,
        scopeJson: scope,
        scopeKey,
      })
      .returning();
    return row!;
  }

  /** The worker reads the full row (no owner gate — the id came from the job). */
  async getById(id: string): Promise<FindingsReportRow | null> {
    const rows = await this.db
      .select()
      .from(findingsReport)
      .where(eq(findingsReport.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Owner-gated read for the status/download endpoints. */
  async getForOwner(userId: string, id: string): Promise<FindingsReportRow | null> {
    const rows = await this.db
      .select()
      .from(findingsReport)
      .where(and(eq(findingsReport.id, id), eq(findingsReport.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async listForOwner(userId: string): Promise<FindingsReportRow[]> {
    return this.db
      .select()
      .from(findingsReport)
      .where(eq(findingsReport.userId, userId))
      .orderBy(desc(findingsReport.createdAt))
      .limit(50);
  }

  /** An unfinished run for the owner, if any — the trigger dedupes on it. */
  async unfinishedForOwner(userId: string): Promise<FindingsReportRow | null> {
    const rows = await this.db
      .select()
      .from(findingsReport)
      .where(
        and(
          eq(findingsReport.userId, userId),
          inArray(findingsReport.status, ['pending', 'running']),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The latest READY run over the same scope before the given run — the delta
   * baseline. Matching is on scope_key, the canonical serialization, so key
   * order in the stored jsonb can never split identical scopes.
   */
  async previousReady(
    userId: string,
    scopeKey: string,
    before: Date,
    excludeId: string,
  ): Promise<FindingsReportRow | null> {
    const rows = await this.db
      .select()
      .from(findingsReport)
      .where(
        and(
          eq(findingsReport.userId, userId),
          eq(findingsReport.scopeKey, scopeKey),
          inArray(findingsReport.status, ['ready', 'expired']),
          lt(findingsReport.createdAt, before),
          ne(findingsReport.id, excludeId),
        ),
      )
      .orderBy(desc(findingsReport.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Progress, written on its OWN connection, deliberately never the job
   * transaction (the ingestion_progress precedent): a stage written inside the
   * job transaction would vanish with the failure it should explain. Swallows
   * its own errors — progress reporting can never fail the run.
   */
  async reportProgress(id: string, progress: ReportProgressDto): Promise<void> {
    try {
      await this.db
        .update(findingsReport)
        .set({ progressJson: progress, status: 'running' })
        .where(
          and(eq(findingsReport.id, id), inArray(findingsReport.status, ['pending', 'running'])),
        );
    } catch {
      // Progress is best-effort by design.
    }
  }

  /**
   * Publish a finished run, but ONLY if it is still in flight. The passport
   * SEC-8 rule applied verbatim: a source deletion expires the owner's
   * in-flight runs inside the enumeration transaction, because the worker
   * assembled them from reads that may already have seen the doomed rows. On a
   * lost race this update matches no row, the caller deletes the objects it
   * just wrote, and the run stays expired. Returns whether the row published.
   */
  async markReady(
    id: string,
    fields: {
      jsonObjectKey: string;
      pdfObjectKey: string;
      jsonSizeBytes: number;
      pdfSizeBytes: number;
      payloadSha256: string;
      signature: string;
      modelConfigId: string;
      counts: FindingsReportDto['counts'];
      previousReportId: string | null;
      readyAt: Date;
      expiresAt: Date;
    },
  ): Promise<boolean> {
    const rows = await this.db
      .update(findingsReport)
      .set({
        status: 'ready',
        jsonObjectKey: fields.jsonObjectKey,
        pdfObjectKey: fields.pdfObjectKey,
        jsonSizeBytes: fields.jsonSizeBytes,
        pdfSizeBytes: fields.pdfSizeBytes,
        payloadSha256: fields.payloadSha256,
        signature: fields.signature,
        modelConfigId: fields.modelConfigId,
        countsJson: fields.counts,
        previousReportId: fields.previousReportId,
        readyAt: fields.readyAt,
        expiresAt: fields.expiresAt,
        progressJson: null,
      })
      .where(and(eq(findingsReport.id, id), inArray(findingsReport.status, ['pending', 'running'])))
      .returning({ id: findingsReport.id });
    return rows.length > 0;
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db
      .update(findingsReport)
      .set({ status: 'failed', error: error.slice(0, 500), progressJson: null })
      .where(
        and(eq(findingsReport.id, id), inArray(findingsReport.status, ['pending', 'running'])),
      );
  }

  /** Ready runs past their artifact expiry — the retention job's work list. */
  async listExpired(now: Date, limit = 100): Promise<FindingsReportRow[]> {
    return this.db
      .select()
      .from(findingsReport)
      .where(and(eq(findingsReport.status, 'ready'), lte(findingsReport.expiresAt, now)))
      .limit(limit);
  }

  /** Expire a run's artifacts; the row and its counts stay for the delta. */
  async markExpired(id: string): Promise<void> {
    await this.db
      .update(findingsReport)
      .set({ status: 'expired', jsonObjectKey: null, pdfObjectKey: null })
      .where(eq(findingsReport.id, id));
  }
}

/** Row → API DTO. Filenames are derived from the creation date. */
export function toReportDto(row: FindingsReportRow): FindingsReportDto {
  const day = row.createdAt.toISOString().slice(0, 10);
  return {
    id: row.id,
    status: row.status,
    reportVersion: row.reportVersion,
    locale: row.locale,
    scope: row.scopeJson,
    modelConfigId: row.modelConfigId ?? null,
    previousReportId: row.previousReportId ?? null,
    counts: row.countsJson ?? null,
    progress: row.progressJson ?? null,
    payloadSha256: row.payloadSha256 ?? null,
    pdfFilename: `cogeto-findings-report-${day}.pdf`,
    jsonFilename: `cogeto-findings-report-${day}.json`,
    pdfSizeBytes: row.pdfSizeBytes ?? null,
    jsonSizeBytes: row.jsonSizeBytes ?? null,
    createdAt: row.createdAt.toISOString(),
    readyAt: row.readyAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    error: row.error ?? null,
  };
}
