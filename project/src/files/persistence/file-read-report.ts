import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DEFAULT_SPACE_ID } from '@cogeto/shared';
import type { AwaitingCapabilityDto, FileReadReportDto } from '@cogeto/shared';
import { DRIZZLE } from '../../infrastructure/index';
import type { Db, DbOrTx } from '../../infrastructure/index';
import type { ReadReport } from '../reading/reader';
import { fileReadReport } from './tables';

/**
 * The read report store (V2.1 item 4.1): one row per file source, recording
 * what the reading layer made of it.
 *
 * Writes run on their OWN connection, never on a caller's transaction, and that
 * is the whole design. The reason a failed read has to be recorded is that the
 * pipeline job then throws; anything written inside that job's transaction
 * disappears with it. So `record` commits independently: the file's `error`
 * state still comes from the queue's dead-letter ledger exactly as before, and
 * this row is what turns that state into an explanation.
 *
 * A retry rewrites the row (upsert on the object key), so the report always
 * describes the LAST attempt, which is the one whose outcome the user is
 * looking at.
 */
@Injectable()
export class FileReadReportStore {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Records (or replaces) the report for one file source. Never throws.
   * `spaceId` is the file's own space (row or staging metadata); absent means
   * the default space, the resolution rule every space column follows. */
  async record(
    objectKey: string,
    ownerId: string,
    report: ReadReport,
    opts: { spaceId?: string; logger?: { warn(message: string): void } } = {},
  ): Promise<void> {
    const logger = opts.logger;
    const spaceId = opts.spaceId ?? DEFAULT_SPACE_ID;
    try {
      await this.db
        .insert(fileReadReport)
        .values({
          objectKey,
          ownerId,
          spaceId,
          format: report.format,
          outcome: report.outcome,
          reasonCode: report.reasonCode,
          detailJson: toDetail(report),
          readAt: new Date(),
        })
        .onConflictDoUpdate({
          target: fileReadReport.objectKey,
          set: {
            ownerId,
            spaceId,
            format: report.format,
            outcome: report.outcome,
            reasonCode: report.reasonCode,
            detailJson: toDetail(report),
            readAt: new Date(),
          },
        });
    } catch (error) {
      // Recording why a read failed must never become a second way for the read
      // to fail. The object key is an identifier, not content (pino rule holds).
      logger?.warn(
        `could not record the read report for ${objectKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** The report for one source, or null. Callers gate on the source first. */
  async get(objectKey: string, db: DbOrTx = this.db): Promise<FileReadReportDto | null> {
    const [row] = await db
      .select()
      .from(fileReadReport)
      .where(eq(fileReadReport.objectKey, objectKey))
      .limit(1);
    if (!row) return null;
    const detail = (row.detailJson ?? {}) as ReadReportDetail;
    return {
      format: row.format,
      outcome: row.outcome as FileReadReportDto['outcome'],
      reasonCode: row.reasonCode,
      segments: detail.segments ?? 0,
      sheets: detail.sheets ?? [],
      valuesUnavailable: detail.valuesUnavailable ?? 0,
      readAt: row.readAt.toISOString(),
      ...(detail.pages ? { pages: detail.pages } : {}),
      ...(detail.visionPagesUsed !== undefined ? { visionPagesUsed: detail.visionPagesUsed } : {}),
    };
  }

  /**
   * Sources this instance could not read for want of a capability (V2.1 item
   * 4.1). Owner-scoped, because a read report is as visible as its source.
   *
   * This is the list an operator works from after turning vision on: without
   * it, "enable vision" leaves every previously unreadable document sitting
   * exactly as it was, and the honest label becomes a permanent one.
   */
  async awaitingCapability(
    ownerId: string,
    options: { limit?: number } = {},
  ): Promise<AwaitingCapabilityDto[]> {
    const rows = await this.db
      .select()
      .from(fileReadReport)
      .where(and(eq(fileReadReport.ownerId, ownerId), eq(fileReadReport.outcome, 'needs_vision')))
      .orderBy(desc(fileReadReport.readAt))
      .limit(options.limit ?? 200);
    return rows.map((row) => {
      const detail = (row.detailJson ?? {}) as ReadReportDetail;
      return {
        objectKey: row.objectKey,
        filename: null,
        outcome: row.outcome as AwaitingCapabilityDto['outcome'],
        reasonCode: row.reasonCode,
        readAt: row.readAt.toISOString(),
        pagesAwaiting: (detail.pages ?? []).filter((page) => page.tier === null).length,
      };
    });
  }

  /** Deletion-cascade leg: the reports for these sources. Returns the count. */
  async deleteForSources(tx: DbOrTx, objectKeys: string[]): Promise<number> {
    if (objectKeys.length === 0) return 0;
    const removed = await tx
      .delete(fileReadReport)
      .where(inArray(fileReadReport.objectKey, objectKeys))
      .returning({ objectKey: fileReadReport.objectKey });
    return removed.length;
  }
}

/** What `detail_json` holds. Counts and accounting, never a fact. */
interface ReadReportDetail {
  granularity?: string;
  segments?: number;
  sheets?: FileReadReportDto['sheets'];
  valuesUnavailable?: number;
  unavailableCells?: string[];
  delimiter?: string;
  encoding?: string;
  pages?: FileReadReportDto['pages'];
  visionPagesUsed?: number;
}

function toDetail(report: ReadReport): ReadReportDetail {
  return {
    granularity: report.granularity,
    segments: report.segments,
    sheets: report.sheets,
    valuesUnavailable: report.valuesUnavailable,
    unavailableCells: report.unavailableCells,
    ...(report.delimiter === undefined ? {} : { delimiter: report.delimiter }),
    ...(report.encoding === undefined ? {} : { encoding: report.encoding }),
    ...(report.pages === undefined ? {} : { pages: report.pages }),
    ...(report.visionPagesUsed === undefined ? {} : { visionPagesUsed: report.visionPagesUsed }),
  };
}

/**
 * Grouped read-report facts for the source catalog (V2.2 item 5.2), as plain
 * functions in the `latestGateRefusalFor` shape: the composing surface passes
 * its handle, the table is named only in this module.
 */
export interface ReadReportBadgeRow {
  objectKey: string;
  outcome: string;
  reasonCode: string | null;
}

/** The outcome per object key, for one page of catalog rows. */
export async function readOutcomesForKeys(
  db: DbOrTx,
  keys: readonly string[],
): Promise<Map<string, ReadReportBadgeRow>> {
  if (keys.length === 0) return new Map();
  const rows = await db
    .select({
      objectKey: fileReadReport.objectKey,
      outcome: fileReadReport.outcome,
      reasonCode: fileReadReport.reasonCode,
    })
    .from(fileReadReport)
    .where(inArray(fileReadReport.objectKey, [...keys]));
  return new Map(rows.map((row) => [row.objectKey, row]));
}

/** The owner's object keys whose read landed on one of `outcomes` — the
 * driving query behind the truncated / unreadable badge filters. Space-scoped
 * inside the query (docs/features/spaces.md): the scan is limit-bounded, so a
 * post-filter would let one space's reports consume another's window. */
export async function keysWithReadOutcome(
  db: DbOrTx,
  ownerId: string,
  outcomes: readonly string[],
  options: { spaceId?: string; limit?: number } = {},
): Promise<string[]> {
  if (outcomes.length === 0) return [];
  const rows = await db
    .select({ objectKey: fileReadReport.objectKey })
    .from(fileReadReport)
    .where(
      and(
        eq(fileReadReport.ownerId, ownerId),
        eq(fileReadReport.spaceId, options.spaceId ?? DEFAULT_SPACE_ID),
        inArray(fileReadReport.outcome, [...outcomes]),
      ),
    )
    .orderBy(desc(fileReadReport.readAt))
    .limit(Math.min(options.limit ?? 200, 500));
  return rows.map((row) => row.objectKey);
}
