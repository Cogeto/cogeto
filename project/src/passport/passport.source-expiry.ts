import { Injectable, Optional } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { DerivedCascade } from '../memory/index';
import { writeAudit } from '../infrastructure/index';
import type { Tx } from '../infrastructure/index';
import { UserDirectory } from '../identity/index';
import { passportExport } from './persistence/tables';

/**
 * Memory Passport exports as a derived artifact of the deletion saga
 * (audit 2.0 SEC-8).
 *
 * A passport export is a signed ZIP of everything its owner could see when it
 * was assembled. Nothing re-opened it when a source was deleted, so for up to
 * `PASSPORT_EXPORT_RETENTION_HOURS` a confirmed receipt said "provably deleted"
 * while a downloadable artifact still held the erased content, and
 * `GET /api/passport/exports/:id/download` still minted presigned URLs for it.
 * That is the signed receipt over-claiming, which is the one failure this
 * product cannot afford.
 *
 * **Expiry is unconditional for the owner's exports, not content-scoped**
 * (decision 0061). Content-scoping would mean opening every ZIP and deciding
 * whether an erased memory is inside, which is expensive, needs the plaintext
 * we are trying to erase, and fails open on any bug. Unconditional expiry is a
 * one-line rule with an obvious proof, and an export is cheap to regenerate:
 * the cost of being too aggressive is a user pressing Export again, and the
 * cost of being too narrow is a receipt that lies.
 *
 * This runs INSIDE the enumeration transaction and performs no external side
 * effect. The object keys it returns join the receipt's `object_keys`, so the
 * worker leg erases the bytes and the nightly integrity sweep verifies them
 * absent, exactly like a file or an email body.
 */
@Injectable()
export class PassportExportCascade implements DerivedCascade {
  readonly artifact = 'passport_exports';

  /** Org resolution for audit stamping (V2.0 item 3.7): this runs in the worker
   * with no Principal in scope, and an entry with no org is readable from every
   * org. Optional so bare test constructions still work. */
  constructor(@Optional() private readonly directory?: UserDirectory) {}

  /**
   * Passport exports are not derived from particular memories, so there is
   * nothing to do per memory id. The owner-scoped hook below is the real work.
   */
  async cascadeForMemories(): Promise<number> {
    return 0;
  }

  async expireForOwner(
    tx: Tx,
    ownerId: string,
    spaceId?: string,
  ): Promise<{ count: number; objectKeys: string[] }> {
    // `pending` exports are in flight: the worker is assembling them from reads
    // that may already have seen the doomed rows, so they are expired too
    // rather than raced. The worker's markReady on an expired row is harmless
    // (it is re-expired by the next deletion, and its object key is recorded
    // here only when it exists).
    const rows = await tx
      .select()
      .from(passportExport)
      .where(
        and(
          eq(passportExport.userId, ownerId),
          // A passport exports ONE space (format 2.1), so only the deletion's
          // space's exports can hold the doomed rows; another space's export
          // stays valid by the seal itself (docs/features/spaces.md). Absent
          // (legacy harnesses) expires across spaces as before.
          ...(spaceId ? [eq(passportExport.spaceId, spaceId)] : []),
          inArray(passportExport.status, ['ready', 'pending']),
        ),
      )
      .for('update');
    if (rows.length === 0) return { count: 0, objectKeys: [] };

    const objectKeys = rows
      .map((row) => row.objectKey)
      .filter((key): key is string => typeof key === 'string' && key.length > 0);

    await tx
      .update(passportExport)
      .set({ status: 'expired', objectKey: null })
      .where(
        inArray(
          passportExport.id,
          rows.map((row) => row.id),
        ),
      );

    await writeAudit(tx, {
      actor: 'deletion_saga',
      action: 'passport.export_expired',
      entityType: 'passport_export',
      entityId: rows[0]!.id,
      detail: { count: rows.length, reason: 'source deletion' },
      orgId: (await this.directory?.orgOf(ownerId)) ?? undefined,
      ownerId,
      spaceId,
    });

    return { count: rows.length, objectKeys };
  }
}
