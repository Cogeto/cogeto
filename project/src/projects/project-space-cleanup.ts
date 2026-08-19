import { Inject, Injectable, Module } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import type { SpaceCleanup } from '../spaces/index';
import { project } from './persistence/tables';

/**
 * Space deletion's projects leg (docs/features/spaces.md section 5): a
 * project is organisation, never content, so removing the space's project
 * rows releases their assignments (ON DELETE CASCADE) and erases nothing —
 * the contents were already erased as sources by the saga.
 */
@Injectable()
export class ProjectSpaceCleanup implements SpaceCleanup {
  readonly artifact = 'projects';

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async countForSpace(spaceId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(project)
      .where(eq(project.spaceId, spaceId));
    return rows[0]?.n ?? 0;
  }

  async cleanupSpace(spaceId: string): Promise<{ count: number; objectKeys: string[] }> {
    const removed = await this.db
      .delete(project)
      .where(eq(project.spaceId, spaceId))
      .returning({ id: project.id });
    return { count: removed.length, objectKeys: [] };
  }
}

/** Slim ports module (the NotesSourcePortsModule shape): DRIZZLE-only. */
@Module({ providers: [ProjectSpaceCleanup], exports: [ProjectSpaceCleanup] })
export class ProjectSpaceCleanupModule {}
