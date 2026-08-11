import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';
import { DRIZZLE } from '../../infrastructure/index';
import type { Db, DbOrTx } from '../../infrastructure/index';
import { connectorItem } from './tables';
import type { ConnectorItemRow } from './tables';

/**
 * The natural-key ledger (V2.5 item 8.1, issue C): the table that stands in
 * front of every model call. The unique index on (connector_id, natural_key)
 * makes "the same item became two sources" unrepresentable; the content hash
 * beside it makes an unchanged item free.
 *
 * The per-case decision table is ENCODED here rather than left to each
 * connector (decision record, docs/features/connectors.md):
 *
 * - unchanged reappearance -> skip, touch last_seen
 * - edited upstream (key stable, hash differs) -> revision: the caller
 *   materializes a new source and this ledger repoints at the tip
 * - moved between containers -> same source, the seen sub-scope recorded
 * - present in two sub-scopes -> one source, both sub-scopes recorded
 * - erased by the user -> stays erased, never re-materialized
 * - deleted upstream -> recorded; the source remains
 */

export type ItemDecision =
  | { action: 'new' }
  | { action: 'unchanged'; item: ConnectorItemRow }
  | { action: 'changed'; item: ConnectorItemRow }
  | { action: 'moved'; item: ConnectorItemRow }
  | { action: 'erased_stays_erased'; item: ConnectorItemRow };

export function contentHashOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

@Injectable()
export class ConnectorItemLedger {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async byNaturalKey(connectorId: string, naturalKey: string): Promise<ConnectorItemRow | null> {
    const rows = await this.db
      .select()
      .from(connectorItem)
      .where(
        and(eq(connectorItem.connectorId, connectorId), eq(connectorItem.naturalKey, naturalKey)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The dedup decision for one listed item, before any expensive work. */
  async decide(
    connectorId: string,
    naturalKey: string,
    contentHash: string,
    subScope: string | null,
  ): Promise<ItemDecision> {
    const item = await this.byNaturalKey(connectorId, naturalKey);
    if (!item) return { action: 'new' };
    if (item.state === 'erased') return { action: 'erased_stays_erased', item };
    if (item.contentHash !== contentHash) return { action: 'changed', item };
    const seen = item.subScopes ?? [];
    if (subScope !== null && !seen.includes(subScope)) return { action: 'moved', item };
    return { action: 'unchanged', item };
  }

  /** First materialization: claim the natural key. Returns null when a
   * concurrent pass already claimed it (the unique index decides). */
  async recordNew(input: {
    connectorId: string;
    ownerId: string;
    naturalKey: string;
    contentHash: string;
    subScope: string | null;
    sourceType: string;
    sourceId: string;
    materializedScope: 'private' | 'shared';
  }): Promise<ConnectorItemRow | null> {
    const rows = await this.db
      .insert(connectorItem)
      .values({
        connectorId: input.connectorId,
        ownerId: input.ownerId,
        naturalKey: input.naturalKey,
        contentHash: input.contentHash,
        subScopes: input.subScope === null ? [] : [input.subScope],
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        materializedScope: input.materializedScope,
      })
      .onConflictDoNothing()
      .returning();
    return rows[0] ?? null;
  }

  /** An upstream edit became a revision: repoint the ledger at the tip. */
  async recordChanged(
    itemId: string,
    input: { contentHash: string; sourceType: string; sourceId: string },
  ): Promise<void> {
    await this.db
      .update(connectorItem)
      .set({
        contentHash: input.contentHash,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        state: 'active',
        changedAt: new Date(),
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(connectorItem.id, itemId));
  }

  async touchSeen(itemId: string, subScope: string | null): Promise<void> {
    const patch: Record<string, unknown> = { lastSeenAt: new Date(), updatedAt: new Date() };
    if (subScope !== null) {
      patch.subScopes = sql`(
        SELECT jsonb_agg(DISTINCT v) FROM jsonb_array_elements_text(
          COALESCE(${connectorItem.subScopes}, '[]'::jsonb) || ${JSON.stringify([subScope])}::jsonb
        ) AS t(v)
      )`;
    }
    await this.db.update(connectorItem).set(patch).where(eq(connectorItem.id, itemId));
  }

  async markDeletedUpstream(itemId: string): Promise<void> {
    await this.db
      .update(connectorItem)
      .set({ state: 'deleted_upstream', lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(connectorItem.id, itemId));
  }

  /**
   * Presence reconciliation (V2.5 item 8.2, issue C5): the observed set of
   * natural keys the upstream still lists for one sub-scope, against the
   * ledger. An active item the upstream no longer lists is marked
   * `deleted_upstream` with the observed reason (`absent`, or `archived`
   * where the upstream can say); its source remains, because deletion is the
   * user's act. A previously gone item the upstream lists again is restored
   * to `active`. Erased items stay erased, always.
   */
  async reconcilePresence(
    connectorId: string,
    subScope: string | null,
    observed: Map<string, 'present' | 'archived'>,
  ): Promise<{ markedGone: number; restored: number }> {
    const inScope = and(
      eq(connectorItem.connectorId, connectorId),
      subScope === null
        ? undefined
        : sql`coalesce(${connectorItem.subScopes}, '[]'::jsonb) ? ${subScope}`,
    );
    const rows = await this.db.select().from(connectorItem).where(inScope);
    let markedGone = 0;
    let restored = 0;
    for (const item of rows) {
      if (item.state === 'erased' || item.state === 'failed') continue;
      const seen = observed.get(item.naturalKey);
      if (item.state === 'active' && seen === undefined) {
        await this.db
          .update(connectorItem)
          .set({ state: 'deleted_upstream', reason: 'absent', updatedAt: new Date() })
          .where(eq(connectorItem.id, item.id));
        markedGone += 1;
      } else if (item.state === 'active' && seen === 'archived') {
        await this.db
          .update(connectorItem)
          .set({ state: 'deleted_upstream', reason: 'archived', updatedAt: new Date() })
          .where(eq(connectorItem.id, item.id));
        markedGone += 1;
      } else if (item.state === 'deleted_upstream' && seen === 'present') {
        await this.db
          .update(connectorItem)
          .set({ state: 'active', reason: null, lastSeenAt: new Date(), updatedAt: new Date() })
          .where(eq(connectorItem.id, item.id));
        restored += 1;
      }
    }
    return { markedGone, restored };
  }

  /** The gone-upstream note for one materialized source, for the surfaces
   * that must say "the upstream no longer lists this" (owner-gated reads). */
  async upstreamStateForSources(
    ownerId: string,
    refs: readonly { sourceType: string; sourceId: string }[],
  ): Promise<Map<string, { state: string; reason: string | null }>> {
    if (refs.length === 0) return new Map();
    const result = new Map<string, { state: string; reason: string | null }>();
    for (const ref of refs) {
      const rows = await this.db
        .select({
          state: connectorItem.state,
          reason: connectorItem.reason,
          sourceId: connectorItem.sourceId,
        })
        .from(connectorItem)
        .where(
          and(
            eq(connectorItem.ownerId, ownerId),
            eq(connectorItem.sourceType, ref.sourceType),
            eq(connectorItem.sourceId, ref.sourceId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (row) result.set(`${ref.sourceType}:${ref.sourceId}`, row);
    }
    return result;
  }

  /**
   * Items materialized today for one connector: the admission bound's
   * denominator (issue E2). The unique index's connector_id prefix serves
   * the scan; the count is bounded by the cap itself in practice.
   */
  async materializedToday(connectorId: string, now = new Date()): Promise<number> {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(connectorItem)
      .where(
        and(eq(connectorItem.connectorId, connectorId), gte(connectorItem.firstSeenAt, dayStart)),
      );
    return rows[0]?.n ?? 0;
  }

  /** The per-sub-scope variant, for the sub-scope cap override. */
  async materializedTodayInScope(
    connectorId: string,
    subScope: string,
    now = new Date(),
  ): Promise<number> {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(connectorItem)
      .where(
        and(
          eq(connectorItem.connectorId, connectorId),
          gte(connectorItem.firstSeenAt, dayStart),
          sql`coalesce(${connectorItem.subScopes}, '[]'::jsonb) ? ${subScope}`,
        ),
      );
    return rows[0]?.n ?? 0;
  }

  /**
   * The deletion cascade's arm (invoked by ConnectorItemCascade): the
   * source was erased by the saga, so the reference is cleared (a dangling
   * provenance reference may not outlive a receipt) and the row is marked
   * erased. The natural key SURVIVES as dedup arithmetic: the user's
   * deletion stands, and a later sync must not resurrect the memory.
   */
  async eraseForSource(tx: DbOrTx, sourceType: string, sourceId: string): Promise<number> {
    const updated = await tx
      .update(connectorItem)
      .set({
        sourceType: null,
        sourceId: null,
        state: 'erased',
        updatedAt: new Date(),
      })
      .where(and(eq(connectorItem.sourceType, sourceType), eq(connectorItem.sourceId, sourceId)))
      .returning({ id: connectorItem.id });
    return updated.length;
  }
}
