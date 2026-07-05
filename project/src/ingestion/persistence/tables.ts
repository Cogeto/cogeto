import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Tables owned by the ingestion module (migration 0003). Module-private —
 * all access goes through the ingestion pipeline.
 *
 * verification_result records the §B.3 verdict that earned each admitted
 * memory its status: supported → active, partial/unsupported → uncertain.
 * The memory_id FK exists for the deletion saga's cascade only; code never
 * reads memory rows from here.
 */

export const verificationVerdictEnum = pgEnum('verification_verdict', [
  'supported',
  'partial',
  'unsupported',
]);

export const verificationResult = pgTable('verification_result', {
  id: uuid('id').primaryKey().defaultRandom(),
  memoryId: uuid('memory_id').notNull(),
  verdict: verificationVerdictEnum('verdict').notNull(),
  reason: text('reason').notNull(),
  promptVersion: text('prompt_version').notNull(),
  /** The extractor's cited source passage (migration 0006); NULL pre-S3-B. */
  sourceSpan: text('source_span'),
  /** The tentative wording that made this memory uncertain (migration 0008; F7). */
  hedgePhrase: text('hedge_phrase'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type VerificationResultRow = typeof verificationResult.$inferSelect;
export type VerificationVerdict = (typeof verificationVerdictEnum.enumValues)[number];

/**
 * The dreaming cycle's tables (migration 0012; decision 0011). Ingestion-owned:
 * dreaming is the consolidation half of the pipeline. Memory-referencing
 * columns FK with CASCADE for the deletion saga only — reads resolve memory
 * details through the gated MemoryStore API, never a join.
 */

export const dreamRun = pgTable(
  'dream_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    scopeFrom: timestamp('scope_from', { withTimezone: true }).notNull(),
    scopeTo: timestamp('scope_to', { withTimezone: true }).notNull(),
    countsJson: jsonb('counts_json'),
  },
  (t) => [index('dream_run_finished_idx').on(t.finishedAt)],
);

export type DreamPass = 'dedup' | 'contradiction' | 'supersession' | 'staleness' | 'dormant';

export const dreamAction = pgTable(
  'dream_action',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull(),
    pass: text('pass').$type<DreamPass>().notNull(),
    memoryId: uuid('memory_id').notNull(),
    relatedMemoryId: uuid('related_memory_id'),
    relationId: uuid('relation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('dream_action_run_idx').on(t.runId)],
);

export const dormantFlag = pgTable(
  'dormant_flag',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memoryId: uuid('memory_id').notNull(),
    runId: uuid('run_id'),
    reason: text('reason').notNull(),
    flaggedAt: timestamp('flagged_at', { withTimezone: true }).notNull().defaultNow(),
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('dormant_flag_open_idx')
      .on(t.memoryId)
      .where(sql`cleared_at IS NULL`),
  ],
);

export type DreamRunRow = typeof dreamRun.$inferSelect;
export type DreamActionRow = typeof dreamAction.$inferSelect;
export type DormantFlagRow = typeof dormantFlag.$inferSelect;
