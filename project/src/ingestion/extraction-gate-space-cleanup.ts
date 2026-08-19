import { Inject, Injectable, Module } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import type { SpaceCleanup } from '../spaces/index';
import { extractionGate, extractionGateRefusal, extractionGateRule } from './persistence/tables';

/**
 * Space deletion's extraction-gate leg (the settings split, migration 0062):
 * gate rows and rules are per-space admission configuration, sealed with the
 * partition they governed, so they go with the space. The count states the
 * configuration rows (gates plus rules), which is what an administrator
 * recognizes in the confirmation; the pass also sweeps any refusal-ledger
 * rows still naming the space (30-day metadata whose sources are erased just
 * before this leg runs), so the final DELETE FROM space keeps its structural
 * completeness proof.
 */
@Injectable()
export class ExtractionGateSpaceCleanup implements SpaceCleanup {
  readonly artifact = 'extraction_gates';

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async countForSpace(spaceId: string): Promise<number> {
    const [gates, rules] = await Promise.all([
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(extractionGate)
        .where(eq(extractionGate.spaceId, spaceId)),
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(extractionGateRule)
        .where(eq(extractionGateRule.spaceId, spaceId)),
    ]);
    return (gates[0]?.n ?? 0) + (rules[0]?.n ?? 0);
  }

  async cleanupSpace(spaceId: string): Promise<{ count: number; objectKeys: string[] }> {
    const rules = await this.db
      .delete(extractionGateRule)
      .where(eq(extractionGateRule.spaceId, spaceId))
      .returning({ id: extractionGateRule.id });
    const gates = await this.db
      .delete(extractionGate)
      .where(eq(extractionGate.spaceId, spaceId))
      .returning({ id: extractionGate.id });
    await this.db.delete(extractionGateRefusal).where(eq(extractionGateRefusal.spaceId, spaceId));
    return { count: rules.length + gates.length, objectKeys: [] };
  }
}

/** Slim ports module (the EntityAliasSpaceCleanupModule shape): DRIZZLE-only. */
@Module({ providers: [ExtractionGateSpaceCleanup], exports: [ExtractionGateSpaceCleanup] })
export class ExtractionGateSpaceCleanupModule {}
