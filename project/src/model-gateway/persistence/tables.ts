import { pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/** Prompt registry (§B.7, migration 0002): versions are immutable once recorded. */
export const promptRegistry = pgTable(
  'prompt_registry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    family: text('family').notNull(),
    version: text('version').notNull(),
    contentHash: text('content_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('prompt_registry_family_version').on(t.family, t.version)],
);
