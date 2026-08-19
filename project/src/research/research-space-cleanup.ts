import { Inject, Injectable, Module } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import type { SpaceCleanup } from '../spaces/index';
import { researchRun } from './persistence/tables';

/**
 * Space deletion's research leg (docs/features/spaces.md section 5): the run
 * records go with the space; the pages they materialized were already erased
 * as `web` sources by the saga, each under its own receipt.
 */
@Injectable()
export class ResearchSpaceCleanup implements SpaceCleanup {
  readonly artifact = 'research_runs';

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async countForSpace(spaceId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(researchRun)
      .where(eq(researchRun.spaceId, spaceId));
    return rows[0]?.n ?? 0;
  }

  async cleanupSpace(spaceId: string): Promise<{ count: number; objectKeys: string[] }> {
    const removed = await this.db
      .delete(researchRun)
      .where(eq(researchRun.spaceId, spaceId))
      .returning({ id: researchRun.id });
    return { count: removed.length, objectKeys: [] };
  }
}

/** Slim ports module (the NotesSourcePortsModule shape): DRIZZLE-only. */
@Module({ providers: [ResearchSpaceCleanup], exports: [ResearchSpaceCleanup] })
export class ResearchSpaceCleanupModule {}
