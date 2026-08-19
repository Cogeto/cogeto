import { Inject, Injectable, Module } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import type { SpaceCleanup } from '../spaces/index';
import { findingsReport } from './persistence/tables';

/**
 * Space deletion's reports leg (docs/features/spaces.md section 5). Ordinary
 * deletions only EXPIRE a report row (the run record is permanent by design);
 * a deleted space is the one case the record itself must go, because a run
 * record describes a partition that no longer exists and its space FK would
 * refuse the final space-row delete. Any artifact keys still on the rows
 * (a `ready` report whose owner had no source erased in this pass) are
 * returned for erasure with the row.
 */
@Injectable()
export class ReportSpaceCleanup implements SpaceCleanup {
  readonly artifact = 'findings_reports';

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async countForSpace(spaceId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(findingsReport)
      .where(eq(findingsReport.spaceId, spaceId));
    return rows[0]?.n ?? 0;
  }

  async cleanupSpace(spaceId: string): Promise<{ count: number; objectKeys: string[] }> {
    const removed = await this.db
      .delete(findingsReport)
      .where(eq(findingsReport.spaceId, spaceId))
      .returning({
        id: findingsReport.id,
        jsonObjectKey: findingsReport.jsonObjectKey,
        pdfObjectKey: findingsReport.pdfObjectKey,
      });
    const objectKeys = removed
      .flatMap((row) => [row.jsonObjectKey, row.pdfObjectKey])
      .filter((key): key is string => typeof key === 'string' && key.length > 0);
    return { count: removed.length, objectKeys };
  }
}

/** Slim ports module (the NotesSourcePortsModule shape): DRIZZLE-only. */
@Module({ providers: [ReportSpaceCleanup], exports: [ReportSpaceCleanup] })
export class ReportSpaceCleanupModule {}
