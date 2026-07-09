import { boolean, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { MEMORY_SCOPES } from '@cogeto/shared';

/**
 * Tables owned by the connectors module (migration 0003; user_settings in
 * 0016). Module-private. `note` holds the notes connector's source rows:
 * memories extracted from a note carry provenance source_type = 'user_note',
 * source_id = note.id (§A.6).
 */

// References the existing `scope` PG type (migration 0001) by name — not a new
// type; the migration SQL owns the DDL.
const scopeEnum = pgEnum('scope', MEMORY_SCOPES);

export const note = pgTable(
  'note',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('note_owner_created_idx').on(t.ownerId, t.createdAt)],
);

export type NoteRow = typeof note.$inferSelect;

/**
 * Per-user capture/upload defaults (§A.9; migration 0016). One row per user,
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
