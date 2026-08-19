import { index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { DEFAULT_SPACE_ID, MEMORY_SCOPES } from '@cogeto/shared';

/**
 * Tables owned by the notes module (migration 0003; split from the connectors
 * context in V2.0 item 3.6 part 4). Module-private. `note` holds the notes
 * connector's source rows: memories extracted from a note carry provenance
 * source_type = 'user_note', source_id = note.id.
 */

// References the existing `scope` PG type (migration 0001) by name.
const scopeEnum = pgEnum('scope', MEMORY_SCOPES);

export const note = pgTable(
  'note',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    content: text('content').notNull(),
    // The capture-time scope (migration 0018); the source reader passes it to
    // the pipeline so derived memories inherit it.
    scope: scopeEnum('scope').notNull().default('private'),
    // The space the note was captured into (docs/features/spaces.md,
    // migration 0060); derived memories inherit it through the reader.
    spaceId: uuid('space_id').notNull().default(DEFAULT_SPACE_ID),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('note_owner_created_idx').on(t.ownerId, t.createdAt)],
);

export type NoteRow = typeof note.$inferSelect;
