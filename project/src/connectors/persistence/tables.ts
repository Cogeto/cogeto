import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { ConnectorState } from '../domain/lifecycle';

/**
 * Tables owned by the connectors platform (V2.5 item 8.1, migration 0054).
 * Module-private. The one deliberately unusual property: `connector_item`
 * carries identifiers and arithmetic ONLY, never content (no names, no
 * titles, no excerpts), which is what lets the natural-key ledger survive
 * source deletion as dedup arithmetic instead of joining the content-bearing
 * cascade. Decision record: docs/features/connectors.md.
 */

export const connector = pgTable(
  'connector',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    orgId: text('org_id').notNull(),
    /** A connector belongs to ONE space (docs/features/spaces.md section 6,
     * migration 0060): connecting the same site into two spaces is two
     * independent connectors, by design. Children inherit through the FK. */
    spaceId: uuid('space_id').notNull(),
    kind: text('kind').notNull(),
    /** User-chosen display name; cleared to NULL on removal (tombstone). */
    name: text('name'),
    state: text('state').$type<ConnectorState>().notNull().default('configured'),
    settingsJson: jsonb('settings_json').$type<ConnectorSettings>(),
    /** Sealed webhook signing secret. Named only in connector-store.ts,
     * asserted by webhook-secret-confinement.spec.ts. */
    webhookSecret: text('webhook_secret'),
    webhookExpiresAt: timestamp('webhook_expires_at', { withTimezone: true }),
    /** When the presence sweep last reconciled the ledger against what the
     * upstream still lists (migration 0055): polling by modified date
     * structurally cannot observe an absence. */
    presenceSweptAt: timestamp('presence_swept_at', { withTimezone: true }),
    /** Owner-gated reason for degraded / needs_reauth; a code plus operator
     * words, never upstream content. */
    statusReason: text('status_reason'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('connector_owner_idx').on(t.ownerId, t.createdAt),
    index('connector_state_idx').on(t.state),
  ],
);

export const connectorSubScope = pgTable(
  'connector_sub_scope',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => connector.id, { onDelete: 'cascade' }),
    ownerId: text('owner_id').notNull(),
    key: text('key').notNull(),
    label: text('label'),
    /** The email-allowlist shape: nothing outside the selection is fetched. */
    selected: boolean('selected').notNull().default(false),
    cursorJson: jsonb('cursor_json'),
    backfillJson: jsonb('backfill_json').$type<SubScopeBackfill>(),
    itemCap: integer('item_cap'),
    /** Per-scope behaviour the user chooses (migration 0055), enforced
     * before fetch, which is cheaper than any gate. */
    settingsJson: jsonb('settings_json').$type<SubScopeSettings>(),
    /** The honest backfill estimate the worker computed for this scope,
     * shown before anything runs (migration 0055). */
    statsJson: jsonb('stats_json').$type<SubScopeStats>(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('connector_sub_scope_key_idx').on(t.connectorId, t.key)],
);

export const connectorItem = pgTable(
  'connector_item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => connector.id),
    ownerId: text('owner_id').notNull(),
    naturalKey: text('natural_key').notNull(),
    contentHash: text('content_hash'),
    subScopes: jsonb('sub_scopes').$type<string[]>(),
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    /** The scope its structural visibility mapped to at first sight; a move
     * implying a different scope is reported, never silently re-stamped. */
    materializedScope: text('materialized_scope').$type<'private' | 'shared'>(),
    state: text('state')
      .$type<'active' | 'deleted_upstream' | 'erased' | 'failed'>()
      .notNull()
      .default('active'),
    reason: text('reason'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    changedAt: timestamp('changed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('connector_item_natural_key_idx').on(t.connectorId, t.naturalKey),
    index('connector_item_source_idx').on(t.sourceType, t.sourceId),
  ],
);

export const connectorSyncRun = pgTable(
  'connector_sync_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => connector.id, { onDelete: 'cascade' }),
    ownerId: text('owner_id').notNull(),
    kind: text('kind').$type<'backfill' | 'incremental' | 'webhook' | 'presence'>().notNull(),
    state: text('state')
      .$type<'running' | 'completed' | 'failed' | 'cancelled'>()
      .notNull()
      .default('running'),
    countsJson: jsonb('counts_json').$type<SyncRunCounts>(),
    reason: text('reason'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('connector_sync_run_connector_idx').on(t.connectorId, t.startedAt)],
);

export const connectorWebhookDelivery = pgTable(
  'connector_webhook_delivery',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => connector.id, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull(),
    /** Identifiers from the VERIFIED payload; signals, never content. */
    itemRefJson: jsonb('item_ref_json').$type<{ naturalKey: string; subScope?: string | null }[]>(),
    state: text('state').$type<'received' | 'processed' | 'failed'>().notNull().default('received'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('connector_webhook_event_idx').on(t.connectorId, t.eventId),
    index('connector_webhook_received_idx').on(t.receivedAt),
  ],
);

export const connectorRateLimit = pgTable(
  'connector_rate_limit',
  {
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => connector.id, { onDelete: 'cascade' }),
    bucket: text('bucket').notNull(),
    tokens: doublePrecision('tokens').notNull(),
    refilledAt: timestamp('refilled_at', { withTimezone: true }).notNull().defaultNow(),
    retryAfterUntil: timestamp('retry_after_until', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.connectorId, t.bucket] })],
);

/** Non-secret connector settings, as stored. */
export interface ConnectorSettings {
  /** Bounded backfill choice (issue C4): defaults 30 days / 500 items per
   * sub-scope; `backfillAll` is the user's EXPLICIT everything. */
  backfillDays?: number;
  backfillItemCap?: number;
  backfillAll?: boolean;
  /** Per-connector daily item cap; absent = the authorship-class default
   * (observed 200, authored 1000). */
  dailyItemCap?: number;
  /** Why the sync is currently waiting, when it is (cap, budget, rate). */
  pausedReason?: string | null;
}

/** Bounded-backfill progress per sub-scope. */
export interface SubScopeBackfill {
  itemsDone: number;
  complete: boolean;
}

/** Per-scope user choices. */
export interface SubScopeSettings {
  /** Pull this scope's attachments as their own sources; off by default
   * because attachments multiply volume. */
  attachments?: boolean;
}

/** The worker-computed backfill estimate for one scope. */
export interface SubScopeStats {
  /** Window the estimate was computed for: 'all', or an ISO date meaning
   * "modified since". */
  window: string;
  estimatedItems: number;
  computedAt: string;
}

/** The sync summary's shape. Every number is real (spec 4.4.4 reporting). */
export interface SyncRunCounts {
  pages: number;
  fetched: number;
  materialized: number;
  unchangedSkipped: number;
  revisions: number;
  moved: number;
  deletedUpstream: number;
  /** Items visible to a subset of users, skipped per spec 4.4.4. */
  skippedRestricted: number;
  /** Scope-affecting container moves reported for the user to act on. */
  scopeChangesReported: number;
  erasedSkipped: number;
  failed: number;
  /** Presence sweep results (migration 0055): items the upstream no longer
   * lists, marked and never deleted, and items that reappeared. */
  presenceMarkedGone?: number;
  presenceRestored?: number;
}

export function emptyCounts(): SyncRunCounts {
  return {
    pages: 0,
    fetched: 0,
    materialized: 0,
    unchangedSkipped: 0,
    revisions: 0,
    moved: 0,
    deletedUpstream: 0,
    skippedRestricted: 0,
    scopeChangesReported: 0,
    erasedSkipped: 0,
    failed: 0,
  };
}

export type ConnectorRow = typeof connector.$inferSelect;
export type ConnectorSubScopeRow = typeof connectorSubScope.$inferSelect;
export type ConnectorItemRow = typeof connectorItem.$inferSelect;
export type ConnectorSyncRunRow = typeof connectorSyncRun.$inferSelect;
export type ConnectorWebhookDeliveryRow = typeof connectorWebhookDelivery.$inferSelect;
