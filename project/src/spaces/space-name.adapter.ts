import { Inject, Injectable, Module } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import type { SpaceNameResolver } from '../passport/index';
import { space } from './persistence/tables';

/**
 * The passport's SpaceNameResolver port, implemented over the space table
 * (docs/features/spaces.md): the per-space passport manifest names the space
 * it exports. The passport module defines the need, this module implements
 * it, the composition roots bind the two through the passport's registration
 * options (the ProjectPolicySource precedent, spec §15 rule 2).
 */
@Injectable()
export class SpaceNameSource implements SpaceNameResolver {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async nameOf(spaceId: string): Promise<string | null> {
    const rows = await this.db
      .select({ name: space.name })
      .from(space)
      .where(eq(space.id, spaceId))
      .limit(1);
    return rows[0]?.name ?? null;
  }
}

/** Standalone binding module, so a root can hand the adapter to the passport
 * registration without pulling the whole spaces surface into that scope. */
@Module({
  providers: [SpaceNameSource],
  exports: [SpaceNameSource],
})
export class SpaceNameModule {}
