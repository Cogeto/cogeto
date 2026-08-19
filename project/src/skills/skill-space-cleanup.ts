import { Inject, Injectable, Module } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import type { SpaceCleanup } from '../spaces/index';
import { skillRun } from './persistence/tables';

/**
 * Space deletion's skills leg (docs/features/spaces.md section 5): the run
 * records and their steps (ON DELETE CASCADE, migration 0034) go with the
 * space; anything a run materialized was already erased as sources.
 */
@Injectable()
export class SkillSpaceCleanup implements SpaceCleanup {
  readonly artifact = 'skill_runs';

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async countForSpace(spaceId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(skillRun)
      .where(eq(skillRun.spaceId, spaceId));
    return rows[0]?.n ?? 0;
  }

  async cleanupSpace(spaceId: string): Promise<{ count: number; objectKeys: string[] }> {
    const removed = await this.db
      .delete(skillRun)
      .where(eq(skillRun.spaceId, spaceId))
      .returning({ id: skillRun.id });
    return { count: removed.length, objectKeys: [] };
  }
}

/** Slim ports module (the NotesSourcePortsModule shape): DRIZZLE-only. */
@Module({ providers: [SkillSpaceCleanup], exports: [SkillSpaceCleanup] })
export class SkillSpaceCleanupModule {}
