import { randomBytes } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { DRIZZLE, openSecret, sealSecret, writeAudit } from '../../infrastructure/index';
import type { Db, DbOrTx } from '../../infrastructure/index';
import { transition } from '../domain/lifecycle';
import type { ConnectorState } from '../domain/lifecycle';
import { CONNECTORS_OPTIONS } from '../connectors.options';
import type { ConnectorsOptions } from '../connectors.options';
import {
  connector,
  connectorRateLimit,
  connectorSubScope,
  connectorSyncRun,
  connectorWebhookDelivery,
} from './tables';
import type {
  ConnectorRow,
  ConnectorSettings,
  ConnectorSubScopeRow,
  ConnectorSyncRunRow,
  SubScopeBackfill,
  SyncRunCounts,
} from './tables';
import type { BucketState } from '../domain/token-bucket';

/**
 * The connector rows: lifecycle, settings, sub-scopes, sync runs, rate
 * state, and the ONE place the sealed webhook signing secret is named
 * (asserted by webhook-secret-confinement.spec.ts). Every lifecycle
 * transition goes through the pure state machine and is audited with
 * structural detail only.
 */
@Injectable()
export class ConnectorStore {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(CONNECTORS_OPTIONS) private readonly options: ConnectorsOptions,
  ) {}

  // ── Connector rows ────────────────────────────────────────────────────────

  async create(input: {
    ownerId: string;
    orgId: string;
    kind: string;
    name: string;
  }): Promise<ConnectorRow> {
    const rows = await this.db
      .insert(connector)
      .values({
        ownerId: input.ownerId,
        orgId: input.orgId,
        kind: input.kind,
        name: input.name,
      })
      .returning();
    const row = rows[0]!;
    await writeAudit(this.db, {
      actor: `user:${input.ownerId}`,
      action: 'connector.created',
      entityType: 'connector',
      entityId: row.id,
      detail: { kind: input.kind },
      orgId: input.orgId,
      ownerId: input.ownerId,
    });
    return row;
  }

  async byId(id: string): Promise<ConnectorRow | null> {
    const rows = await this.db.select().from(connector).where(eq(connector.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /** Owner-scoped read for the API; a foreign id is indistinguishable from
   * an absent one. */
  async byIdForOwner(id: string, ownerId: string): Promise<ConnectorRow> {
    const rows = await this.db
      .select()
      .from(connector)
      .where(and(eq(connector.id, id), eq(connector.ownerId, ownerId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException('no such connector');
    return row;
  }

  async listForOwner(ownerId: string): Promise<ConnectorRow[]> {
    return this.db
      .select()
      .from(connector)
      .where(and(eq(connector.ownerId, ownerId), sql`${connector.state} <> 'removed'`))
      .orderBy(connector.createdAt);
  }

  /** Connectors the maintenance pass considers, instance-wide. */
  async listInStates(states: ConnectorState[]): Promise<ConnectorRow[]> {
    return this.db.select().from(connector).where(inArray(connector.state, states));
  }

  /**
   * A lifecycle transition, validated by the pure state machine, audited.
   * `reason` is stored on the owner-gated row, never in the audit detail.
   */
  async transition(
    executor: DbOrTx,
    row: Pick<ConnectorRow, 'id' | 'ownerId' | 'orgId' | 'state'>,
    to: ConnectorState,
    opts: { actor: string; reason?: string | null } = { actor: 'connector_platform' },
  ): Promise<void> {
    const decision = transition(row.state, to);
    if (!decision.ok) throw new ConflictException(decision.reason);
    if (row.state === to && opts.reason === undefined) return;
    await executor
      .update(connector)
      .set({ state: to, statusReason: opts.reason ?? null, updatedAt: new Date() })
      .where(eq(connector.id, row.id));
    await writeAudit(executor, {
      actor: opts.actor,
      action: 'connector.state_changed',
      entityType: 'connector',
      entityId: row.id,
      detail: { from: row.state, to },
      orgId: row.orgId,
      ownerId: row.ownerId,
    });
  }

  async updateSettings(id: string, settings: ConnectorSettings): Promise<void> {
    await this.db
      .update(connector)
      .set({ settingsJson: settings, updatedAt: new Date() })
      .where(eq(connector.id, id));
  }

  async recordSyncFinished(id: string): Promise<void> {
    await this.db
      .update(connector)
      .set({ lastSyncAt: new Date(), updatedAt: new Date() })
      .where(eq(connector.id, id));
  }

  /**
   * Removal, transactionally complete except for the credential (destroyed
   * by the caller through identity's store in the same transaction): every
   * cursor, sub-scope, pending delivery and rate row is deleted; the row is
   * tombstoned (name cleared, the import_item precedent); the item ledger
   * SURVIVES as dedup arithmetic. Already-ingested sources are not touched:
   * deleting a connector must not silently erase memory.
   */
  async remove(
    tx: DbOrTx,
    row: Pick<ConnectorRow, 'id' | 'ownerId' | 'orgId' | 'state'>,
    actor: string,
  ): Promise<void> {
    const decision = transition(row.state, 'removed');
    if (!decision.ok) throw new ConflictException(decision.reason);
    await tx.delete(connectorSubScope).where(eq(connectorSubScope.connectorId, row.id));
    await tx
      .delete(connectorWebhookDelivery)
      .where(eq(connectorWebhookDelivery.connectorId, row.id));
    await tx.delete(connectorRateLimit).where(eq(connectorRateLimit.connectorId, row.id));
    await tx
      .update(connector)
      .set({
        state: 'removed',
        name: null,
        settingsJson: null,
        webhookSecret: null,
        webhookExpiresAt: null,
        statusReason: null,
        updatedAt: new Date(),
      })
      .where(eq(connector.id, row.id));
    await writeAudit(tx, {
      actor,
      action: 'connector.removed',
      entityType: 'connector',
      entityId: row.id,
      detail: { from: row.state, sourcesRetained: true },
      orgId: row.orgId,
      ownerId: row.ownerId,
    });
  }

  // ── The sealed webhook signing secret ────────────────────────────────────
  // The one secret the APP must open (the ingress verifies signatures), which
  // is why it is not an identity credential: the credential opener is
  // worker-only. Sealed with the same secret-box; named only in this file.

  /** Generate and store a fresh signing secret; return it ONCE for the user
   * to configure upstream. It is never retrievable again. */
  async rotateWebhookSecret(row: Pick<ConnectorRow, 'id' | 'ownerId' | 'orgId'>): Promise<string> {
    const secret = randomBytes(32).toString('hex');
    await this.db
      .update(connector)
      .set({
        webhookSecret: sealSecret(this.options.masterKey, secret),
        updatedAt: new Date(),
      })
      .where(eq(connector.id, row.id));
    await writeAudit(this.db, {
      actor: `user:${row.ownerId}`,
      action: 'connector.webhook_secret_rotated',
      entityType: 'connector',
      entityId: row.id,
      detail: { rotated: true },
      orgId: row.orgId,
      ownerId: row.ownerId,
    });
    return secret;
  }

  /** The single decrypting read, called by the ingress verifier only. */
  async openWebhookSecret(connectorId: string): Promise<string | null> {
    const rows = await this.db
      .select({ sealed: connector.webhookSecret })
      .from(connector)
      .where(eq(connector.id, connectorId))
      .limit(1);
    const sealed = rows[0]?.sealed;
    if (!sealed) return null;
    return openSecret(this.options.masterKey, sealed);
  }

  async recordWebhookExpiry(connectorId: string, expiresAt: Date | null): Promise<void> {
    await this.db
      .update(connector)
      .set({ webhookExpiresAt: expiresAt, updatedAt: new Date() })
      .where(eq(connector.id, connectorId));
  }

  // ── Sub-scopes ────────────────────────────────────────────────────────────

  /** Upsert discovery results, preserving selection and cursor state. */
  async recordDiscoveredSubScopes(
    connectorId: string,
    ownerId: string,
    scopes: { key: string; label: string }[],
  ): Promise<void> {
    for (const scope of scopes) {
      await this.db
        .insert(connectorSubScope)
        .values({ connectorId, ownerId, key: scope.key, label: scope.label })
        .onConflictDoUpdate({
          target: [connectorSubScope.connectorId, connectorSubScope.key],
          set: { label: scope.label, updatedAt: new Date() },
        });
    }
  }

  async subScopes(connectorId: string): Promise<ConnectorSubScopeRow[]> {
    return this.db
      .select()
      .from(connectorSubScope)
      .where(eq(connectorSubScope.connectorId, connectorId))
      .orderBy(connectorSubScope.key);
  }

  async selectedSubScopes(connectorId: string): Promise<ConnectorSubScopeRow[]> {
    return this.db
      .select()
      .from(connectorSubScope)
      .where(
        and(eq(connectorSubScope.connectorId, connectorId), eq(connectorSubScope.selected, true)),
      )
      .orderBy(connectorSubScope.key);
  }

  async setSubScopeSelection(
    row: Pick<ConnectorRow, 'id' | 'ownerId' | 'orgId'>,
    key: string,
    patch: { selected?: boolean; itemCap?: number | null },
  ): Promise<void> {
    const updated = await this.db
      .update(connectorSubScope)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(connectorSubScope.connectorId, row.id), eq(connectorSubScope.key, key)))
      .returning({ id: connectorSubScope.id });
    if (updated.length === 0) throw new NotFoundException('no such sub-scope');
    await writeAudit(this.db, {
      actor: `user:${row.ownerId}`,
      action: 'connector.sub_scope_changed',
      entityType: 'connector',
      entityId: row.id,
      detail: {
        selected: patch.selected ?? null,
        hasItemCap: patch.itemCap !== undefined ? patch.itemCap !== null : null,
      },
      orgId: row.orgId,
      ownerId: row.ownerId,
    });
  }

  /** The cursor, persisted after every processed page (issue C1). */
  async recordCursor(connectorId: string, key: string, cursor: unknown): Promise<void> {
    await this.db
      .update(connectorSubScope)
      .set({ cursorJson: cursor ?? null, updatedAt: new Date() })
      .where(and(eq(connectorSubScope.connectorId, connectorId), eq(connectorSubScope.key, key)));
  }

  async recordBackfill(
    connectorId: string,
    key: string,
    backfill: SubScopeBackfill,
  ): Promise<void> {
    await this.db
      .update(connectorSubScope)
      .set({ backfillJson: backfill, updatedAt: new Date() })
      .where(and(eq(connectorSubScope.connectorId, connectorId), eq(connectorSubScope.key, key)));
  }

  /**
   * The implicit whole-connector scope for descriptors without sub-scopes:
   * one row under the reserved empty key, selected from birth.
   */
  async ensureImplicitScope(connectorId: string, ownerId: string): Promise<void> {
    await this.db
      .insert(connectorSubScope)
      .values({ connectorId, ownerId, key: '', label: null, selected: true })
      .onConflictDoNothing();
  }

  // ── Sync runs ─────────────────────────────────────────────────────────────

  async openSyncRun(
    connectorId: string,
    ownerId: string,
    kind: 'backfill' | 'incremental' | 'webhook',
  ): Promise<ConnectorSyncRunRow> {
    const existing = await this.db
      .select()
      .from(connectorSyncRun)
      .where(
        and(eq(connectorSyncRun.connectorId, connectorId), eq(connectorSyncRun.state, 'running')),
      )
      .limit(1);
    if (existing[0]) return existing[0];
    const rows = await this.db
      .insert(connectorSyncRun)
      .values({ connectorId, ownerId, kind })
      .returning();
    return rows[0]!;
  }

  async recordRunCounts(runId: string, counts: SyncRunCounts): Promise<void> {
    await this.db
      .update(connectorSyncRun)
      .set({ countsJson: counts })
      .where(eq(connectorSyncRun.id, runId));
  }

  async closeSyncRun(
    runId: string,
    state: 'completed' | 'failed' | 'cancelled',
    reason?: string | null,
  ): Promise<void> {
    await this.db
      .update(connectorSyncRun)
      .set({ state, reason: reason ?? null, finishedAt: new Date() })
      .where(eq(connectorSyncRun.id, runId));
  }

  async recentSyncRuns(connectorId: string, limit = 20): Promise<ConnectorSyncRunRow[]> {
    return this.db
      .select()
      .from(connectorSyncRun)
      .where(eq(connectorSyncRun.connectorId, connectorId))
      .orderBy(desc(connectorSyncRun.startedAt))
      .limit(limit);
  }

  // ── Durable rate state (issue E1) ────────────────────────────────────────

  async rateState(connectorId: string, bucket: string): Promise<BucketState | null> {
    const rows = await this.db
      .select()
      .from(connectorRateLimit)
      .where(
        and(eq(connectorRateLimit.connectorId, connectorId), eq(connectorRateLimit.bucket, bucket)),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { tokens: row.tokens, refilledAt: row.refilledAt, retryAfterUntil: row.retryAfterUntil };
  }

  async saveRateState(connectorId: string, bucket: string, state: BucketState): Promise<void> {
    await this.db
      .insert(connectorRateLimit)
      .values({
        connectorId,
        bucket,
        tokens: state.tokens,
        refilledAt: state.refilledAt,
        retryAfterUntil: state.retryAfterUntil,
      })
      .onConflictDoUpdate({
        target: [connectorRateLimit.connectorId, connectorRateLimit.bucket],
        set: {
          tokens: state.tokens,
          refilledAt: state.refilledAt,
          retryAfterUntil: state.retryAfterUntil,
        },
      });
  }

  // ── Webhook deliveries (issue D) ─────────────────────────────────────────

  /**
   * Record a verified delivery; false = duplicate (the unique index held),
   * which the ingress acknowledges 200 and drops.
   */
  async recordDelivery(
    tx: DbOrTx,
    input: {
      connectorId: string;
      eventId: string;
      itemRefs: { naturalKey: string; subScope?: string | null }[];
    },
  ): Promise<{ id: string } | null> {
    const rows = await tx
      .insert(connectorWebhookDelivery)
      .values({
        connectorId: input.connectorId,
        eventId: input.eventId,
        itemRefJson: input.itemRefs,
      })
      .onConflictDoNothing()
      .returning({ id: connectorWebhookDelivery.id });
    return rows[0] ?? null;
  }

  async delivery(id: string) {
    const rows = await this.db
      .select()
      .from(connectorWebhookDelivery)
      .where(eq(connectorWebhookDelivery.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async markDelivery(id: string, state: 'processed' | 'failed'): Promise<void> {
    await this.db
      .update(connectorWebhookDelivery)
      .set({ state, processedAt: new Date() })
      .where(eq(connectorWebhookDelivery.id, id));
  }

  async pruneDeliveriesOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const deleted = await this.db
      .delete(connectorWebhookDelivery)
      .where(lt(connectorWebhookDelivery.receivedAt, cutoff))
      .returning({ id: connectorWebhookDelivery.id });
    return deleted.length;
  }
}
