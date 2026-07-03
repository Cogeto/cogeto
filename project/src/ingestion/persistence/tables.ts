import { pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type VerificationResultRow = typeof verificationResult.$inferSelect;
export type VerificationVerdict = (typeof verificationVerdictEnum.enumValues)[number];
