import { index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

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
