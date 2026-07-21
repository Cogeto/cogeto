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
    /**
     * The normalized commitment text a create_task intent captured from this
     * message (migration 0025; decision 0038) — the pipeline's extraction
     * input when set. The raw message stays untouched as the §A.6 provenance
     * target; NULL for every message not captured as a task request.
     */
    captureContent: text('capture_content'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chat_message_owner_created_idx').on(t.ownerId, t.createdAt)],
);

export type ChatMessageRow = typeof chatMessage.$inferSelect;
