import {
  bigint,
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
 * may not be touched cross-module (spec §15 rule 2). Append-only is enforced by a
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
  /** Whose artifact the entry concerns (migration 0020): the
   * reader returns detail_json only to this owner; NULL = system entry. */
  ownerId: text('owner_id'),
  /** The space the audited action happened in (docs/features/spaces.md,
   * migration 0061): an ATTRIBUTE for filtering, never a gate, and never a
   * foreign key, because an audit entry outlives every space, deleted ones
   * included. NULL = a genuinely instance-level action, never "unknown". */
  spaceId: uuid('space_id'),
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
 * Per-user instance context and language preference (migration 0029). Lives
 * here, not in a domain module, because the context feeds prompts in retrieval,
 * connectors and ingestion alike, and no single bounded context owns it
 * (spec §15 rule 2). The attention read-state pair used to be justified the
 * same way and no longer is: it moved to the `attention` context in V2.0 item
 * 3.6 part 2, because that surface both owns and is the only writer of it.
 */
export const userContext = pgTable('user_context', {
  userId: text('user_id').primaryKey(),
  orgId: text('org_id').notNull(),
  displayName: text('display_name'),
  company: text('company'),
  roleTitle: text('role_title'),
  aboutWork: text('about_work'),
  /** Per-user IANA zone override; NULL = the instance timezone. */
  timezone: text('timezone'),
  preferredLanguage: text('preferred_language').notNull().default('en'),
  languageStrict: boolean('language_strict').notNull().default(false),
  /** Provenance when a value was accepted from a suggestion. */
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

/**
 * Durable abuse limits (migration 0038; security audit 2.0 SEC-18/SEC-10).
 * Both tables are content-free counters shared by the app and the worker, so a
 * restart no longer clears the only ceiling on model spend and the two
 * processes count one number instead of two halves.
 *
 * `usage_counter.task_family` is part of the key so per-user / per-period /
 * per-task-family reporting can read this table later without a migration;
 * every enforced limit SUMs across families.
 */
export const usageCounter = pgTable(
  'usage_counter',
  {
    userId: text('user_id').notNull(),
    /** The metered resource: model_calls, model_tokens, capture, upload, … */
    bucket: text('bucket').notNull(),
    /** UTC calendar day, 'YYYY-MM-DD'. A new day is a new key, never a reset. */
    period: text('period').notNull(),
    /** The work that caused the spend ('ingestion', 'chat', …); '' if unattributed. */
    taskFamily: text('task_family').notNull().default(''),
    count: bigint('count', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.bucket, t.period, t.taskFamily] })],
);

export const rateLimitWindow = pgTable(
  'rate_limit_window',
  {
    principalId: text('principal_id').notNull(),
    bucket: text('bucket').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.principalId, t.bucket] })],
);
