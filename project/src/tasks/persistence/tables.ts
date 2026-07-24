import {
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
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
    /**
     * User-adopted (migration 0030; decision 0054): the user turned an observed
     * memory into this task ("Make this a task") — the first-person act the
     * derivation rule requires. Adopted tasks behave identically afterwards and
     * are never touched by the derivation-rule cleanup.
     */
    adopted: boolean('adopted').notNull().default(false),
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

export const taskConclusionTypeEnum = pgEnum('task_conclusion_type', ['closed', 'condition_met']);

/**
 * The durable provenance row behind source_type 'task_conclusion' (migration
 * 0025; decision 0037). One row per concluded event; the derived memory's
 * §A.6 provenance points here, and the row carries the inspectable chain
 * (task → deriving memory, trigger memory). FKs are SET NULL, never CASCADE:
 * provenance must outlive what it references — the statement is self-contained.
 */
export const taskConclusion = pgTable(
  'task_conclusion',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    scope: scopeEnum('scope').notNull(),
    sensitive: boolean('sensitive').notNull().default(false),
    taskId: uuid('task_id'),
    conclusionType: taskConclusionTypeEnum('conclusion_type').notNull(),
    statement: text('statement').notNull(),
    derivingMemoryId: uuid('deriving_memory_id'),
    triggerMemoryId: uuid('trigger_memory_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('task_conclusion_once_idx').on(t.taskId, t.conclusionType, t.triggerMemoryId),
    index('task_conclusion_task_idx').on(t.taskId),
    index('task_conclusion_owner_idx').on(t.ownerId),
  ],
);

export type TaskConclusionRow = typeof taskConclusion.$inferSelect;
