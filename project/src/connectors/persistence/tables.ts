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
 * Tables owned by the connectors module (migration 0003).
 * Module-private. `note` holds the notes connector's source rows
 * memories extracted from a note carry provenance source_type = 'user_note',
 * source_id = note.id.
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
    // the pipeline so derived memories inherit it.
    scope: scopeEnum('scope').notNull().default('private'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('note_owner_created_idx').on(t.ownerId, t.createdAt)],
);

export type NoteRow = typeof note.$inferSelect;

/**
 * Per-user capture/upload defaults (migration 0016). One row per user,
 * created on first write — a read with no row returns the column defaults.
 */
/**
 * Inbound email (migration 0021). Owned by
 * connectors. `email_message` + its raw MinIO object are the complete retained
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

/**
 * Fetched web pages (migration 0027). Owned
 * by connectors. The retained extracted text + URL are the complete source of
 * record (raw HTML optionally externalised to `rawObjectKey`); memories
 * extracted from a page carry provenance source_type = 'web',
 * source_id = web_page.id, and their temporal anchor is `fetchedAt`.
 */
export const webPage = pgTable(
  'web_page',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    scope: scopeEnum('scope').notNull().default('private'),
    sensitive: boolean('sensitive').notNull().default(false),
    requestedUrl: text('requested_url').notNull(),
    finalUrl: text('final_url').notNull(),
    title: text('title'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    retainedText: text('retained_text').notNull(),
    /** The focused extraction view (migration 0032): the
     * chunks most relevant to the run's sent query, ranked by embeddings at
     * capture time. NULL = extract from retainedText as before. */
    extractionText: text('extraction_text'),
    rawObjectKey: text('raw_object_key'),
    // The research run whose approved query led to this page (Part B,
    // migration 0028) — the provenance chain memory → web_page →
    // research_run.sent_query. Null for direct URL captures.
    researchRunId: uuid('research_run_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('web_page_owner_fetched_idx').on(t.ownerId, t.fetchedAt),
    index('web_page_research_run_idx').on(t.researchRunId),
  ],
);

export type WebPageRow = typeof webPage.$inferSelect;

/** The gate's states: discovery runs ONLY from 'approved'.
 * 'concluded' (migration 0032) is the terminal success state —
 * the worker synthesised and stored the answer after the last page settled. */
export const researchRunStatusEnum = pgEnum('research_run_status', [
  'proposed',
  'approved',
  'cancelled',
  'concluded',
]);

/**
 * A research run (migration 0028) — the
 * auditable record of one research invocation: the user's intent, the proposed
 * query, the minimised query + reason, and — only after
 * explicit approval — the EXACT text that left the instance (`sentQuery`,
 * post-edit). "You see precisely what leaves, and you approve it" is enforced
 * here, not in the UI.
 */
export const researchRun = pgTable(
  'research_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    intent: text('intent').notNull(),
    proposedQuery: text('proposed_query').notNull(),
    minimisedQuery: text('minimised_query').notNull(),
    minimiseReason: text('minimise_reason').notNull(),
    sentQuery: text('sent_query'),
    status: researchRunStatusEnum('status').notNull().default('proposed'),
    answer: text('answer'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /** The chat conversation this run was invoked from (migration 0033) —
     * where the concluded answer is appended as a persistent assistant
     * message. NULL for Research-page runs. Value reference, no FK. */
    conversationId: uuid('conversation_id'),
    /** Server-side conclusion (migration 0032): when the worker stored the answer. */
    concludedAt: timestamp('concluded_at', { withTimezone: true }),
    /** When the owner saw the stored answer — the chat resume surface shows a
     * run until this is set, never after. */
    answerSeenAt: timestamp('answer_seen_at', { withTimezone: true }),
    /** The skill run this research run is one approved-plan query of
     * (migration 0034). Same-module value reference, no FK
     * the research run is the immutable record of what left and must outlive
     * any future skill-run pruning. NULL for manual research. */
    skillRunId: uuid('skill_run_id'),
  },
  (t) => [
    index('research_run_owner_created_idx').on(t.ownerId, t.createdAt),
    index('research_run_skill_run_idx').on(t.skillRunId),
  ],
);

export type ResearchRunRow = typeof researchRun.$inferSelect;

/** Skill run lifecycle: the gate pause (awaiting_approval) is
 * a stored state; completed/failed/cancelled are terminal. */
export const skillRunStatusEnum = pgEnum('skill_run_status', [
  'planning',
  'awaiting_approval',
  'running',
  'awaiting_input',
  'completed',
  'failed',
  'cancelled',
]);

export const skillStepStatusEnum = pgEnum('skill_step_status', [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
]);

/**
 * One skill invocation (migration 0034): a named,
 * versioned, code-defined workflow's durable run record. The brief + its
 * resolved citations persist here (renderable forever, citation links live).
 * A skill creates nothing of its own: it reads, searches, and
 * writes a brief — the adoption-proposal column went with the task subsystem
 * (migration 0035).
 */
export const skillRun = pgTable(
  'skill_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    /** The owner's org, captured at propose time — the worker executes as the
     * owner and object keys need the real org segment there. */
    orgId: text('org_id').notNull().default(''),
    skillId: text('skill_id').notNull(),
    skillVersion: text('skill_version').notNull(),
    subject: text('subject').notNull(),
    status: skillRunStatusEnum('status').notNull().default('planning'),
    brief: text('brief'),
    briefCitations: jsonb('brief_citations'),
    failureReason: text('failure_reason'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('skill_run_owner_created_idx').on(t.ownerId, t.createdAt)],
);

export type SkillRunRow = typeof skillRun.$inferSelect;

/**
 * The step log — the inspectability claim as rows
 * per step, its status, inputs/outputs summary, and links to everything it
 * produced. UNIQUE (skill_run_id, step_key) is the checkpoint claim the
 * re-runnable advance job compare-and-sets.
 */
export const skillRunStep = pgTable(
  'skill_run_step',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    skillRunId: uuid('skill_run_id').notNull(),
    position: integer('position').notNull(),
    stepKey: text('step_key').notNull(),
    kind: text('kind').notNull(),
    status: skillStepStatusEnum('status').notNull().default('pending'),
    inputsSummary: text('inputs_summary'),
    outputsSummary: text('outputs_summary'),
    links: jsonb('links').notNull().default({}),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('skill_run_step_skill_run_id_step_key_key').on(t.skillRunId, t.stepKey),
    index('skill_run_step_run_idx').on(t.skillRunId, t.position),
  ],
);

export type SkillRunStepRow = typeof skillRunStep.$inferSelect;
