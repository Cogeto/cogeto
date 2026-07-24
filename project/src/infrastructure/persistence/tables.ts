import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Infrastructure tables (migration 0002 + audit_log from 0001).
 *
 * audit_log lives here, not in a domain module: every module appends audit rows
 * (memory transitions, approval decisions, deletions), and module-owned tables
 * may not be touched cross-module (§A.1 rule 2). Append-only is enforced by a
 * database trigger (see migration 0001).
 */

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  detailJson: jsonb('detail_json'),
  /** Org for org-scoped reads (migration 0016); NULL = system/global entry. */
  orgId: text('org_id'),
  /** Whose artifact the entry concerns (migration 0020, QS-1/QS-13): the
   * reader returns detail_json only to this owner; NULL = system entry. */
  ownerId: text('owner_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const outboxEvent = pgTable(
  'outbox_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('outbox_event_type_idx').on(t.eventType, t.createdAt)],
);

export const jobExecution = pgTable(
  'job_execution',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    jobType: text('job_type').notNull(),
    executedAt: timestamp('executed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('job_execution_idempotency_key').on(t.sourceType, t.sourceId, t.jobType)],
);

export const deadLetter = pgTable('dead_letter', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobType: text('job_type').notNull(),
  payload: jsonb('payload'),
  error: text('error').notNull(),
  attempts: integer('attempts').notNull(),
  failedAt: timestamp('failed_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Attention read-state (migration 0026, decision 0039). The attention feed and
 * dashboard stats are computed; these two content-free per-user tables are the
 * only materialized state. They live here — not in a domain module — because
 * the surface spans every context and none owns it (§A.1 rule 2), exactly like
 * audit_log.
 */
export const attentionState = pgTable('attention_state', {
  ownerId: text('owner_id').primaryKey(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

export const attentionDismissal = pgTable(
  'attention_dismissal',
  {
    ownerId: text('owner_id').notNull(),
    /** Content-free key (run ids + within-run indices); never memory text. */
    itemKey: text('item_key').notNull(),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.itemKey] })],
);

/**
 * Per-user instance context and language preference (migration 0029, decisions
 * 0051/0052/0053). Lives here, not in a domain module, because the context
 * feeds prompts in retrieval, connectors, ingestion and tasks alike — no
 * single bounded context owns it (§A.1 rule 2), exactly like attention_state.
 */
export const userContext = pgTable('user_context', {
  userId: text('user_id').primaryKey(),
  orgId: text('org_id').notNull(),
  displayName: text('display_name'),
  company: text('company'),
  roleTitle: text('role_title'),
  aboutWork: text('about_work'),
  /** Per-user IANA zone override; NULL = the instance timezone (QS-32). */
  timezone: text('timezone'),
  preferredLanguage: text('preferred_language').notNull().default('en'),
  languageStrict: boolean('language_strict').notNull().default(false),
  /** Provenance when a value was accepted from a suggestion (decision 0053). */
  companySourceMemoryId: uuid('company_source_memory_id'),
  roleTitleSourceMemoryId: uuid('role_title_source_memory_id'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const contextSuggestionDismissal = pgTable(
  'context_suggestion_dismissal',
  {
    userId: text('user_id').notNull(),
    field: text('field').notNull(),
    value: text('value').notNull(),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.field, t.value] })],
);
