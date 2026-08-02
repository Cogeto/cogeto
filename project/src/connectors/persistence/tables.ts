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
 * Module-private.
 */

// References the existing `scope` PG type (migration 0001) by name — not a new
// type; the migration SQL owns the DDL.
const scopeEnum = pgEnum('scope', MEMORY_SCOPES);

/**
 * Per-user capture/upload defaults (migration 0016). One row per user,
 * created on first write — a read with no row returns the column defaults.
 */
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
