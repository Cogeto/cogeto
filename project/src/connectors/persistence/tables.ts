import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
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
    // The capture-time scope (migration 0018); the source reader passes it to
    // the pipeline so derived memories inherit it (O2-B).
    scope: scopeEnum('scope').notNull().default('private'),
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

/**
 * Inbound email (Session O4, decision 0028; migration 0021). Owned by
 * connectors. `email_message` + its raw MinIO object are the complete retained
 * message (full retention, ruling 5); memories extracted from an email carry
 * provenance source_type = 'email', source_id = email_message.id (§A.6).
 */
export const emailMessage = pgTable(
  'email_message',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    scope: scopeEnum('scope').notNull().default('private'),
    sensitive: boolean('sensitive').notNull().default(false),
    messageId: text('message_id'),
    inReplyTo: text('in_reply_to'),
    references: text('references').array().notNull().default([]),
    fromAddr: text('from_addr').notNull(),
    toAddr: text('to_addr').notNull(),
    subject: text('subject'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    rawObjectKey: text('raw_object_key').notNull(),
    textBody: text('text_body'),
    htmlBody: text('html_body'),
    htmlObjectKey: text('html_object_key'),
    headersJson: jsonb('headers_json').notNull().default({}),
    hasAttachments: boolean('has_attachments').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('email_message_owner_received_idx').on(t.ownerId, t.receivedAt)],
);

export type EmailMessageRow = typeof emailMessage.$inferSelect;

/**
 * Every attachment on an accepted message is recorded (ruling 8). Supported
 * document types are additionally stored + enqueued as their own file source
 * (source_type 'file'); `fileObjectKey` is that source's object key. Unsupported
 * types get a row but no processing — their bytes stay in the retained raw
 * original.
 */
export const emailAttachment = pgTable(
  'email_attachment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    emailId: uuid('email_id').notNull(),
    filename: text('filename'),
    contentType: text('content_type'),
    sizeBytes: integer('size_bytes').notNull().default(0),
    fileObjectKey: text('file_object_key'),
    processed: boolean('processed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('email_attachment_email_idx').on(t.emailId)],
);

export type EmailAttachmentRow = typeof emailAttachment.$inferSelect;

/** The two allowlist entry kinds (decision 0028 ruling 2a). */
export const emailAllowlistKindEnum = pgEnum('email_allowlist_kind', ['address', 'domain']);

/**
 * The sender allowlist — the primary acceptance gate (ruling 2). Empty by
 * default → nothing external is accepted (closed by default). Values are stored
 * normalized (lower-cased; domains bare, no leading '@').
 */
export const emailAllowlist = pgTable(
  'email_allowlist',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    kind: emailAllowlistKindEnum('kind').notNull(),
    value: text('value').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('email_allowlist_owner_kind_value_idx').on(t.ownerId, t.kind, t.value)],
);

export type EmailAllowlistRow = typeof emailAllowlist.$inferSelect;

/**
 * Metadata-only log of refused mail (ruling 7): sender, time, reason — never a
 * body. Powers the "recent refusals → allowlist in one click" affordance.
 */
export const emailRefusal = pgTable(
  'email_refusal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id'),
    fromAddr: text('from_addr'),
    toAddr: text('to_addr'),
    reason: text('reason').notNull(),
    refusedAt: timestamp('refused_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('email_refusal_refused_idx').on(t.refusedAt)],
);

export type EmailRefusalRow = typeof emailRefusal.$inferSelect;
