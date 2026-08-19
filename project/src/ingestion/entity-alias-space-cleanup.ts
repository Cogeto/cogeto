import { Inject, Injectable, Module } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import type { SpaceCleanup } from '../spaces/index';
import { entityAlias } from './persistence/tables';

/**
 * Space deletion's alias leg (docs/features/spaces.md section 5): the alias
 * vocabulary is sealed with the corpus it describes, so it goes with the
 * space. Another space aliasing the same surface forms is untouched, which is
 * the per-space aliasing rule working in the deletion direction.
 */
@Injectable()
export class EntityAliasSpaceCleanup implements SpaceCleanup {
  readonly artifact = 'entity_aliases';

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async countForSpace(spaceId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(entityAlias)
      .where(eq(entityAlias.spaceId, spaceId));
    return rows[0]?.n ?? 0;
  }

  async cleanupSpace(spaceId: string): Promise<{ count: number; objectKeys: string[] }> {
    const removed = await this.db
      .delete(entityAlias)
      .where(eq(entityAlias.spaceId, spaceId))
      .returning({ id: entityAlias.id });
    return { count: removed.length, objectKeys: [] };
  }
}

/** Slim ports module (the NotesSourcePortsModule shape): DRIZZLE-only. */
@Module({ providers: [EntityAliasSpaceCleanup], exports: [EntityAliasSpaceCleanup] })
export class EntityAliasSpaceCleanupModule {}
