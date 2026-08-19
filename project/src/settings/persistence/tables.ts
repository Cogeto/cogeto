import { boolean, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { DEFAULT_SPACE_ID, MEMORY_SCOPES } from '@cogeto/shared';

/**
 * Tables owned by the settings module (migration 0016; split from the
 * connectors context in V2.0 item 3.6 part 4). Module-private.
 */

// References the existing `scope` PG type (migration 0001) by name — not a new
// type; the migration SQL owns the DDL.
const scopeEnum = pgEnum('scope', MEMORY_SCOPES);

/**
 * Per-user, per-space capture/upload defaults (migration 0016; the space
 * dimension since 0062, the settings split of docs/features/spaces.md
 * section 4). One row per (user, space), created on first write — a read with
 * no row returns the column defaults, which is what makes a new space begin
 * with sensible defaults rather than empty ones.
 */
export const userSettings = pgTable(
  'user_settings',
  {
    userId: text('user_id').notNull(),
    /** The space these defaults govern; cascades with it (a preference row is
     * per-user state about a space, never content). */
    spaceId: uuid('space_id').notNull().default(DEFAULT_SPACE_ID),
    orgId: text('org_id').notNull(),
    discardByDefault: boolean('discard_by_default').notNull().default(false),
    defaultScope: scopeEnum('default_scope').notNull().default('private'),
    /** Auto-research: a knowledge answer that would offer web research just
     * does it. Research behaviour is content behaviour, so it is per space. */
    autoResearch: boolean('auto_research').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.spaceId] })],
);

export type UserSettingsRow = typeof userSettings.$inferSelect;
