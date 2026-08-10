import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AmbiguityDecisionDto } from '@cogeto/shared';

/**
 * Tables owned by the retrieval module's chat area (migrations 0005 + 0031).
 * Module-private (dependency-cruiser persistence rule). Chat messages persist
 * conversations AND are the provenance targets for future chat-derived
 * memories (source_type = 'chat' points here).
 */

export const chatRoleEnum = pgEnum('chat_role', ['user', 'assistant']);

/**
 * A conversation: the workspace container the sidebar
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
    /**
     * The subject this conversation is currently about (issue #479, migration
     * 0051), so a pronoun still binds after a digression. Set ONLY when a turn
     * genuinely resolved a subject; never inferred from retrieval scores.
     * Content-bearing, and erased with the conversation by the existing delete.
     */
    focusSubject: text('focus_subject'),
    focusSetAt: timestamp('focus_set_at', { withTimezone: true }),
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
     * The model's displayed deliberation (Part C of reasoning support,
     * migration 0044): a CHANNEL beside the answer, never content. Null for
     * user rows and non-reasoning models. Content-bearing, so the answer
     * redaction cascade nulls it with the content overwrite, and row deletion
     * takes it implicitly.
     */
    thinking: text('thinking'),
    /**
     * The recorded ambiguity decision (V2.3 item 6.3, migration 0050): the
     * spec §7.5 branch, the clusters considered with their scores, config
     * version and embedding model. Null means "not computed" (user rows,
     * non-grounded replies, pre-feature rows). Content-bearing (cluster
     * subjects are entity names), so the answer redaction cascade nulls it
     * with the content overwrite; row deletion takes it implicitly.
     */
    ambiguity: jsonb('ambiguity').$type<AmbiguityDecisionDto>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('chat_message_owner_created_idx').on(t.ownerId, t.createdAt),
    index('chat_message_conversation_created_idx').on(t.conversationId, t.createdAt),
  ],
);

/**
 * One file attached in a conversation (V2.2 item 5.1, migration 0045).
 *
 * Durable rows are LINKS: the file itself is an ordinary file source (its
 * object key is `object_key`), and this row lets the conversation render the
 * honest card — progress, then the stamped outcome (facts, contradictions,
 * read outcome, gate refusal). When the file source is deleted, the cascade
 * nulls `display_name` (a filename is erased with its bytes) and marks the
 * row `source_deleted`.
 *
 * Transient rows are CONTENT: `content_text` is what the reading layer made
 * of a "don't remember this file" attachment, held for this conversation's
 * answer path only, erased by the conversation deletion saga and counted on
 * its receipt. `staging_key` points at the staged bytes until the read job
 * commits their deletion, then nulls.
 */
export const chatAttachment = pgTable(
  'chat_attachment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    /** The user message it was sent with; null for an attachment sent alone. */
    messageId: uuid('message_id'),
    transient: boolean('transient').notNull(),
    objectKey: text('object_key'),
    stagingKey: text('staging_key'),
    displayName: text('display_name'),
    contentType: text('content_type'),
    sizeBytes: integer('size_bytes'),
    status: text('status')
      .$type<'pending' | 'ready' | 'failed' | 'settled' | 'source_deleted'>()
      .notNull()
      .default('pending'),
    contentText: text('content_text'),
    readOutcome: text('read_outcome'),
    readReason: text('read_reason'),
    factsCount: integer('facts_count'),
    contradictionsCount: integer('contradictions_count'),
    gateRefusal: text('gate_refusal'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [
    index('chat_attachment_conversation_idx').on(t.conversationId, t.createdAt),
    index('chat_attachment_object_key_idx').on(t.objectKey),
  ],
);

export type ChatMessageRow = typeof chatMessage.$inferSelect;
export type ConversationRow = typeof conversation.$inferSelect;
export type ChatAttachmentRow = typeof chatAttachment.$inferSelect;
