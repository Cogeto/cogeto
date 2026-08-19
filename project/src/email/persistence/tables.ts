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
import { DEFAULT_SPACE_ID, MEMORY_SCOPES } from '@cogeto/shared';

/**
 * Tables owned by the email module (migration 0021; split from the connectors
 * context in V2.0 item 3.6 part 4). Module-private.
 */

// References the existing `scope` PG type (migration 0001) by name.
const scopeEnum = pgEnum('scope', MEMORY_SCOPES);

/**
 * Inbound email (migration 0021). `email_message` + its raw MinIO object are the complete retained
 * message (full retention, ruling 5); memories extracted from an email carry
 * provenance source_type = 'email', source_id = email_message.id.
 */
export const emailMessage = pgTable(
  'email_message',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    scope: scopeEnum('scope').notNull().default('private'),
    sensitive: boolean('sensitive').notNull().default(false),
    // The space the message was routed into (docs/features/spaces.md
    // section 6c, migration 0063): resolved BEFORE anything is stored, from
    // the recipient's alias rule, else the matched sender rule's target,
    // else the default space. Intake has no Principal, so the routing rules
    // are the machine path's space binding; an alias without a rule is
    // refused, never defaulted.
    spaceId: uuid('space_id').notNull().default(DEFAULT_SPACE_ID),
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
    // Deterministic summary of any text/calendar (VEVENT) parts (GAP-4, migration
    // 0024); appended to the extraction input by the SourceReader after isolation.
    calendarSummary: text('calendar_summary'),
    headersJson: jsonb('headers_json').notNull().default({}),
    hasAttachments: boolean('has_attachments').notNull().default(false),
    /**
     * Intake-time routing fact (migration 0030): true when this
     * copy was self-routed (rule 1 — the authenticated sender IS
     * the capture user), false when allowlist-routed (someone else wrote it).
     * NULL = pre-0030 row awaiting the authorship backfill. The SourceReader
     * combines it with forward detection into the memories' authored_by_user.
     */
    authoredByOwner: boolean('authored_by_owner'),
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

/** The two allowlist entry kinds (ruling 2a). */
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
    // The space this sender's mail lands in (docs/features/spaces.md
    // section 6c, migration 0063). A rule is owner-level configuration WITH
    // a space target, never a per-space rule set: which space's rules govern
    // an inbound message is exactly the unknown routing must resolve. The
    // DEFAULT keeps every pre-routing rule landing where it always did; the
    // email space cleanup leg removes rules whose target space is erased.
    spaceId: uuid('space_id').notNull().default(DEFAULT_SPACE_ID),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('email_allowlist_owner_kind_value_idx').on(t.ownerId, t.kind, t.value)],
);

export type EmailAllowlistRow = typeof emailAllowlist.$inferSelect;

/**
 * Per-owner alias routing rules (docs/features/spaces.md section 6c,
 * migration 0063): mail to the instance address plus-tagged with the alias
 * (`capture+alias@instance`) lands in the named space. An alias the
 * recipient has not defined is REFUSED, never defaulted: the sender named a
 * partition explicitly, and landing that mail anywhere else is the
 * misplacement the spaces feature exists to prevent.
 */
export const emailAlias = pgTable(
  'email_alias',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    alias: text('alias').notNull(),
    spaceId: uuid('space_id').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('email_alias_owner_alias_idx').on(t.ownerId, t.alias)],
);

export type EmailAliasRow = typeof emailAlias.$inferSelect;

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
