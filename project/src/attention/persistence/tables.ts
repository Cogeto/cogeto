import { primaryKey, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Attention read-state (migration 0026).
 *
 * The feed and the dashboard statistics are COMPUTED per Principal; these two
 * content-free per-user tables are the only materialized state on the surface,
 * which is why they follow it here (V2.0 item 3.6 part 2).
 *
 * They used to live in `infrastructure` under the reasoning that the surface
 * spans every context and none of them owns it. That was true of the *reads*
 * and false of the *state*: the state is only ever written by the attention
 * surface, and parking it in shared infrastructure meant the aggregator read a
 * table nobody owned from a composition root (recorded exception B10). Same
 * tables, same columns, no migration: only the owning module changed.
 */

export const attentionState = pgTable('attention_state', {
  ownerId: text('owner_id').primaryKey(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

export const attentionDismissal = pgTable(
  'attention_dismissal',
  {
    ownerId: text('owner_id').notNull(),
    /** Content-free key (run ids + within-run indices); never memory text. */
    itemKey: text('item_key').notNull(),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.itemKey] })],
);
