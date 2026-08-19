import { Injectable, Optional } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { DerivedCascade } from '../memory/index';
import { writeAudit } from '../infrastructure/index';
import type { Tx } from '../infrastructure/index';
import { UserDirectory } from '../identity/index';
import { findingsReport } from './persistence/tables';

/**
 * Findings reports as a derived artifact of the deletion saga — the passport
 * SEC-8 rule applied to the SECOND content-bearing artifact, so the gap the
 * audit found once cannot recur here.
 *
 * A ready report quotes verbatim source spans. **Expiry is unconditional for
 * the owner's reports, not content-scoped** (the passport's decision 0061
 * rationale holds verbatim): deciding whether an erased memory is quoted
 * inside a rendered PDF would need the plaintext being erased and fails open
 * on any bug, while regeneration is one click. In-flight runs are expired
 * too rather than raced; the executor's markReady guard handles the rest.
 *
 * Runs INSIDE the enumeration transaction, no external side effects. The
 * object keys returned join the receipt's `object_keys`, so the worker leg
 * erases the bytes and the nightly integrity sweep verifies them absent. The
 * ROW survives as `expired`: it carries only scope, counts and integrity
 * metadata, never quoted content, and the delta view needs the run record.
 */
@Injectable()
export class FindingsReportCascade implements DerivedCascade {
  readonly artifact = 'findings_reports';

  /** Org resolution for audit stamping: the saga runs in the worker with no
   * Principal in scope. Optional so bare test constructions still work. */
  constructor(@Optional() private readonly directory?: UserDirectory) {}

  /** Reports are owner-derived, not per-memory; the hook below is the work. */
  async cascadeForMemories(): Promise<number> {
    return 0;
  }

  async expireForOwner(
    tx: Tx,
    ownerId: string,
    spaceId?: string,
  ): Promise<{ count: number; objectKeys: string[] }> {
    const rows = await tx
      .select()
      .from(findingsReport)
      .where(
        and(
          eq(findingsReport.userId, ownerId),
          // A findings report covers one space by construction (its run
          // enumerates space-carrying sources), so only the deletion's
          // space's reports can quote the doomed material
          // (docs/features/spaces.md). Absent (legacy harnesses) expires
          // across spaces as before.
          ...(spaceId ? [eq(findingsReport.spaceId, spaceId)] : []),
          // 'failed' joins the list: a failed attempt may have recorded and
          // uploaded artifact keys before it failed, and those bytes must
          // ride the same receipt as everything else.
          inArray(findingsReport.status, ['ready', 'pending', 'running', 'failed']),
        ),
      )
      .for('update');
    if (rows.length === 0) return { count: 0, objectKeys: [] };

    const objectKeys = rows
      .flatMap((row) => [row.jsonObjectKey, row.pdfObjectKey])
      .filter((key): key is string => typeof key === 'string' && key.length > 0);

    await tx
      .update(findingsReport)
      .set({ status: 'expired', jsonObjectKey: null, pdfObjectKey: null })
      .where(
        inArray(
          findingsReport.id,
          rows.map((row) => row.id),
        ),
      );

    await writeAudit(tx, {
      actor: 'deletion_saga',
      action: 'report.expired',
      entityType: 'findings_report',
      entityId: rows[0]!.id,
      detail: { count: rows.length, reason: 'source deletion' },
      orgId: (await this.directory?.orgOf(ownerId)) ?? undefined,
      ownerId,
      spaceId,
    });

    return { count: rows.length, objectKeys };
  }
}
