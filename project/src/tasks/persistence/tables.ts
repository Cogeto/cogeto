import { boolean, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { MEMORY_SCOPES, TASK_STATUSES } from '@cogeto/shared';

// The shared `scope` pg enum, re-declared locally: migrations are hand-written
// SQL (no drizzle-kit generation), so this descriptor only names the existing
// type — importing memory's would violate the persistence-privacy rule.
const scopeEnum = pgEnum('scope', MEMORY_SCOPES);

/**
 * The task table (migration 0014; decision 0013 ruling 1). Tasks-owned and
 * module-private; the memory FKs exist for the deletion cascade safety net
 * only — reads resolve memory details through the gated MemoryStore API.
 * One task per deriving memory (UNIQUE), following the supersession chain.
 */

export const taskStatusEnum = pgEnum('task_status', TASK_STATUSES);

export const task = pgTable(
  'task',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    scope: scopeEnum('scope').notNull(),
    derivedFromMemoryId: uuid('derived_from_memory_id').notNull().unique(),
    title: text('title').notNull(),
    primaryPerson: text('primary_person'),
    entities: text('entities').array().notNull().default([]),
    conditionText: text('condition_text'),
    conditionMet: boolean('condition_met').notNull().default(false),
    conditionMetByMemoryId: uuid('condition_met_by_memory_id'),
    due: timestamp('due', { withTimezone: true }),
    status: taskStatusEnum('status').notNull().default('open'),
    closedByMemoryId: uuid('closed_by_memory_id'),
    dormant: boolean('dormant').notNull().default(false),
    fromUncertain: boolean('from_uncertain').notNull().default(false),
    // Reminder state (migration 0017; F3 handoff §2): a set timestamp means a
    // pending reminder of that kind. The reminders pass stamps once per window;
    // close/dismiss and dormancy-resolution clear. NOT a second table — additive
    // columns, pre-approved by the handoff.
    dueRemindedAt: timestamp('due_reminded_at', { withTimezone: true }),
    dormantRemindedAt: timestamp('dormant_reminded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('task_owner_status_idx').on(t.ownerId, t.status)],
);

export type TaskRow = typeof task.$inferSelect;
