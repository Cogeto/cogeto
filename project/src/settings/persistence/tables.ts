import { boolean, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { MEMORY_SCOPES } from '@cogeto/shared';

/**
 * Tables owned by the settings module (migration 0016; split from the
 * connectors context in V2.0 item 3.6 part 4). Module-private.
 */

// References the existing `scope` PG type (migration 0001) by name — not a new
// type; the migration SQL owns the DDL.
const scopeEnum = pgEnum('scope', MEMORY_SCOPES);

/**
 * Per-user capture/upload defaults (migration 0016). One row per user,
 * created on first write — a read with no row returns the column defaults.
 */
export const userSettings = pgTable('user_settings', {
  userId: text('user_id').primaryKey(),
  orgId: text('org_id').notNull(),
  discardByDefault: boolean('discard_by_default').notNull().default(false),
  defaultScope: scopeEnum('default_scope').notNull().default('private'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UserSettingsRow = typeof userSettings.$inferSelect;
