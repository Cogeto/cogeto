import { boolean, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { DEFAULT_SPACE_ID, MEMORY_SCOPES } from '@cogeto/shared';

/**
 * Tables owned by the research module (migrations 0027 + 0028; split from the
 * connectors context in V2.0 item 3.6 part 4). Module-private.
 */

// References the existing `scope` PG type (migration 0001) by name.
const scopeEnum = pgEnum('scope', MEMORY_SCOPES);

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
    // The space the page was captured into (docs/features/spaces.md,
    // migration 0060): the run's space, stamped in the same transaction that
    // creates the source.
    spaceId: uuid('space_id').notNull().default(DEFAULT_SPACE_ID),
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
    // The space the run was started in (docs/features/spaces.md, migration
    // 0060): every page it captures inherits it.
    spaceId: uuid('space_id').notNull().default(DEFAULT_SPACE_ID),
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
