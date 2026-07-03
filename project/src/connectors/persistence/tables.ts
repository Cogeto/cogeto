import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Tables owned by the connectors module (migration 0003). Module-private.
 * `note` holds the notes connector's source rows: memories extracted from a
 * note carry provenance source_type = 'user_note', source_id = note.id (§A.6).
 */

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
