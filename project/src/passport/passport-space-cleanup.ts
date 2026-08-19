import { Inject, Injectable, Module } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { passportExport } from './persistence/tables';

/**
 * Space deletion's passport leg (docs/features/spaces.md section 5). A
 * passport exports ONE space (format 2.1), so a deleted space's export rows
 * describe a partition that no longer exists and go with it; any artifact
 * keys still on the rows are returned for erasure. The receipts a passport
 * carried remain valid where they always lived: the deletion_receipt table,
 * whose rows outlive the space as the proof of its erasure.
 *
 * Satisfies the spaces module's SpaceCleanup port STRUCTURALLY, without
 * naming it: spaces' barrel reaches passport through the space-name adapter
 * (the session-1 port), so importing spaces back from here would close a
 * cycle. The registration option's `Type<SpaceCleanup>` bound still checks
 * the shape at the composition roots.
 */
@Injectable()
export class PassportSpaceCleanup {
  readonly artifact = 'passport_exports';

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async countForSpace(spaceId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(passportExport)
      .where(eq(passportExport.spaceId, spaceId));
    return rows[0]?.n ?? 0;
  }

  async cleanupSpace(spaceId: string): Promise<{ count: number; objectKeys: string[] }> {
    const removed = await this.db
      .delete(passportExport)
      .where(eq(passportExport.spaceId, spaceId))
      .returning({ id: passportExport.id, objectKey: passportExport.objectKey });
    const objectKeys = removed
      .map((row) => row.objectKey)
      .filter((key): key is string => typeof key === 'string' && key.length > 0);
    return { count: removed.length, objectKeys };
  }
}

/** Slim ports module (the NotesSourcePortsModule shape): DRIZZLE-only. */
@Module({ providers: [PassportSpaceCleanup], exports: [PassportSpaceCleanup] })
export class PassportSpaceCleanupModule {}
