import { boolean, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Tables owned by the retrieval module's chat area (migrations 0005 + 0031).
 * Module-private (dependency-cruiser persistence rule). Chat messages persist
 * conversations AND are the §A.6 provenance targets for future chat-derived
 * memories (source_type = 'chat' points here).
 */

export const chatRoleEnum = pgEnum('chat_role', ['user', 'assistant']);

/**
 * A conversation (P6.9; decision 0056): the workspace container the sidebar
 * lists, switches, renames, archives and deletes. Memory is the continuity,
 * conversations are workspaces — context assembly reads turns from ONE
 * conversation only; knowledge crosses threads through memory retrieval alone.
 */
export const conversation = pgTable(
  'conversation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    /** NULL until auto-titled after the first exchange, or renamed by the user. */
    title: text('title'),
    /** A manual rename wins forever — the auto-titler never touches it again. */
    titleSetByUser: boolean('title_set_by_user').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Last-message time — the sidebar's recency order. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('conversation_owner_updated_idx').on(t.ownerId, t.updatedAt)],
);

export const chatMessage = pgTable(
  'chat_message',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    /** The conversation this message lives in (migration 0031) — NOT NULL: a
     * message always lands in the conversation it was sent to. */
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id),
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
  (t) => [
    index('chat_message_owner_created_idx').on(t.ownerId, t.createdAt),
    index('chat_message_conversation_created_idx').on(t.conversationId, t.createdAt),
  ],
);

export type ChatMessageRow = typeof chatMessage.$inferSelect;
export type ConversationRow = typeof conversation.$inferSelect;
