import { Inject, Injectable, Module } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import type { SpaceCleanup } from '../spaces/index';
import { approval } from './persistence/tables';

/**
 * Space deletion's approvals leg (docs/features/spaces.md section 6a: shared
 * material dies with its space; spaces verification F1). Approvals became a
 * space-scoped surface in session 2 but no cleanup leg owned the table, so a
 * space that ever raised one could never finish deleting: the NO ACTION space
 * foreign key refused the final row delete forever, loudly and correctly, but
 * with no remedy inside the product.
 *
 * The disposition is DELETION, for every approval kind, decided after
 * checking each. A reply draft's payload is content-bearing (a drafted body
 * grounded on the space's own memories and the erased email), so it must die
 * with the space like every other content row. A bulk-outdate approval is
 * closer to a record of a decision, but its payload names memory ids that
 * die with the space and carries the requester's free-text reason about that
 * space's content, and the decision trail itself is not lost: every
 * transition wrote an instance-level audit row (approval.created / approved /
 * rejected / executed) that survives with the space attribute, exactly like
 * every other erased container's history. Re-homing was rejected because a
 * space's rows appearing in another partition is the misplacement this
 * feature exists to forbid.
 */
@Injectable()
export class AgentsSpaceCleanup implements SpaceCleanup {
  readonly artifact = 'approvals';

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async countForSpace(spaceId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(approval)
      .where(eq(approval.spaceId, spaceId));
    return rows[0]?.n ?? 0;
  }

  async cleanupSpace(spaceId: string): Promise<{ count: number; objectKeys: string[] }> {
    const removed = await this.db
      .delete(approval)
      .where(eq(approval.spaceId, spaceId))
      .returning({ id: approval.id });
    return { count: removed.length, objectKeys: [] };
  }
}

/** Slim ports module (the ReportSpaceCleanupModule shape): DRIZZLE-only. */
@Module({ providers: [AgentsSpaceCleanup], exports: [AgentsSpaceCleanup] })
export class AgentsSpaceCleanupModule {}
