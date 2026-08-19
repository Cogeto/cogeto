import { Inject, Injectable, Module } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import type { SpaceCleanup } from '../spaces/index';
import { emailAlias, emailAllowlist } from './persistence/tables';

/**
 * Space deletion's email-routing leg (docs/features/spaces.md section 6c).
 * A routing rule dies with its target space: a sender rule or an alias rule
 * pointing at an erased partition must not fall back anywhere (falling back
 * would misfile a client's mail, the one forbidden outcome), so both rule
 * kinds are removed and mail arriving afterwards refuses legibly as
 * `alias_not_recognized` or `sender_not_recognized`, recorded in the refusal
 * ledger. The rules' space FKs are the loud mid-erasure backstop that makes
 * this leg mandatory before the final space-row delete.
 */
@Injectable()
export class EmailRoutingSpaceCleanup implements SpaceCleanup {
  readonly artifact = 'email_routing_rules';

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async countForSpace(spaceId: string): Promise<number> {
    const [senders, aliases] = await Promise.all([
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(emailAllowlist)
        .where(eq(emailAllowlist.spaceId, spaceId)),
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(emailAlias)
        .where(eq(emailAlias.spaceId, spaceId)),
    ]);
    return (senders[0]?.n ?? 0) + (aliases[0]?.n ?? 0);
  }

  async cleanupSpace(spaceId: string): Promise<{ count: number; objectKeys: string[] }> {
    const removedSenders = await this.db
      .delete(emailAllowlist)
      .where(eq(emailAllowlist.spaceId, spaceId))
      .returning({ id: emailAllowlist.id });
    const removedAliases = await this.db
      .delete(emailAlias)
      .where(eq(emailAlias.spaceId, spaceId))
      .returning({ id: emailAlias.id });
    return { count: removedSenders.length + removedAliases.length, objectKeys: [] };
  }
}

/** Slim ports module (the ReportSpaceCleanupModule shape): DRIZZLE-only. */
@Module({ providers: [EmailRoutingSpaceCleanup], exports: [EmailRoutingSpaceCleanup] })
export class EmailRoutingSpaceCleanupModule {}
