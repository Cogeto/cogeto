import { index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Tables owned by the retrieval module's chat area (migration 0005).
 * Module-private (dependency-cruiser persistence rule). Chat messages persist
 * conversations AND are the §A.6 provenance targets for future chat-derived
 * memories (source_type = 'chat' points here).
 */

export const chatRoleEnum = pgEnum('chat_role', ['user', 'assistant']);

export const chatMessage = pgTable(
  'chat_message',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    role: chatRoleEnum('role').notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chat_message_owner_created_idx').on(t.ownerId, t.createdAt)],
);

export type ChatMessageRow = typeof chatMessage.$inferSelect;
