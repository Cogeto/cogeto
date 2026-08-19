import {
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
import { DEFAULT_SPACE_ID } from '@cogeto/shared';

/**
 * Tables owned by the connectors module (migration 0034): the named-skill
 * runtime, the last family standing before the part-4 split completes.
 * Module-private.
 */

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
    /** The caller's space at propose time (docs/features/spaces.md, migration
     * 0060): the worker's gated reads and everything the run produces stay
     * inside it. Steps inherit through the run. */
    spaceId: uuid('space_id').notNull().default(DEFAULT_SPACE_ID),
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
