import { Inject, Injectable, Module, Optional } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import { ConnectorCredentialStore } from '../identity/index';
import type { SpaceCleanup } from '../spaces/index';
import { connector, connectorItem } from './persistence/tables';

/**
 * Space deletion's connectors leg (docs/features/spaces.md section 5). The
 * ordinary connector REMOVAL is deliberately soft — credentials and sync
 * state destroyed, the row tombstoned, the natural-key ledger kept as dedup
 * arithmetic so a later sync cannot resurrect erased memories. A DELETED
 * SPACE is the one case all of that goes too: there is no later sync of a
 * partition that no longer exists, and the tombstoned row's space FK would
 * refuse the final space-row delete. Credentials are destroyed through the
 * identity seam's one store, audited there; the connector row's deletion
 * cascades its sub-scopes, sync runs, webhook deliveries and rate-limit
 * state; the ledger rows (NO ACTION on their connector FK) are removed
 * explicitly first.
 */
@Injectable()
export class ConnectorSpaceCleanup implements SpaceCleanup {
  readonly artifact = 'connectors';

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    /** The identity seam's credential store (a global seam module export). */
    @Optional() private readonly credentials?: ConnectorCredentialStore,
  ) {}

  async countForSpace(spaceId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(connector)
      .where(eq(connector.spaceId, spaceId));
    return rows[0]?.n ?? 0;
  }

  async cleanupSpace(spaceId: string): Promise<{ count: number; objectKeys: string[] }> {
    const rows = await this.db
      .select({ id: connector.id, ownerId: connector.ownerId, orgId: connector.orgId })
      .from(connector)
      .where(eq(connector.spaceId, spaceId));
    for (const row of rows) {
      await this.db.transaction(async (tx) => {
        await this.credentials?.destroy(tx, {
          connectorId: row.id,
          ownerId: row.ownerId,
          orgId: row.orgId,
          actor: 'space_erasure',
          spaceId,
        });
        await tx.delete(connectorItem).where(eq(connectorItem.connectorId, row.id));
        await tx.delete(connector).where(eq(connector.id, row.id));
      });
    }
    return { count: rows.length, objectKeys: [] };
  }
}

/** Slim ports module: DRIZZLE plus the global identity seam. */
@Module({ providers: [ConnectorSpaceCleanup], exports: [ConnectorSpaceCleanup] })
export class ConnectorSpaceCleanupModule {}
