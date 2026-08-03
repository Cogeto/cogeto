import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import type { FileReadReportDto } from '@cogeto/shared';
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

  /** Records (or replaces) the report for one file source. Never throws. */
  async record(
    objectKey: string,
    ownerId: string,
    report: ReadReport,
    logger?: { warn(message: string): void },
  ): Promise<void> {
    try {
      await this.db
        .insert(fileReadReport)
        .values({
          objectKey,
          ownerId,
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
    };
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
  };
}
