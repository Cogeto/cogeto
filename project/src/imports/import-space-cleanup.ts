import { Inject, Injectable, Module } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import type { SpaceCleanup } from '../spaces/index';
import { importRun } from './persistence/tables';

/**
 * Space deletion's imports leg (docs/features/spaces.md section 5): the run
 * record and its items (ON DELETE CASCADE) go with the space. Item names for
 * INGESTED sources were already tombstoned per source by the saga's cascade;
 * removing the runs outright is correct here because the arithmetic they keep
 * describes a partition that no longer exists.
 */
@Injectable()
export class ImportSpaceCleanup implements SpaceCleanup {
  readonly artifact = 'import_runs';

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async countForSpace(spaceId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(importRun)
      .where(eq(importRun.spaceId, spaceId));
    return rows[0]?.n ?? 0;
  }

  async cleanupSpace(spaceId: string): Promise<{ count: number; objectKeys: string[] }> {
    const removed = await this.db
      .delete(importRun)
      .where(eq(importRun.spaceId, spaceId))
      .returning({ id: importRun.id });
    return { count: removed.length, objectKeys: [] };
  }
}

/** Slim ports module (the NotesSourcePortsModule shape): DRIZZLE-only. */
@Module({ providers: [ImportSpaceCleanup], exports: [ImportSpaceCleanup] })
export class ImportSpaceCleanupModule {}
