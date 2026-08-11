import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { MEMORY_SCOPES, UNCERTAINTY_REASONS } from '@cogeto/shared';
import type { ReadLocator } from '@cogeto/shared';

/**
 * Tables owned by the ingestion module (migration 0003). Module-private —
 * all access goes through the ingestion pipeline.
 *
 * verification_result records the spec §2 verdict that earned each admitted
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
  /** The extractor's cited source passage (migration 0006); NULL pre-. */
  sourceSpan: text('source_span'),
  /** The tentative wording that made this memory uncertain (migration 0008; F7). */
  hedgePhrase: text('hedge_phrase'),
  /**
   * The span resolved to the reader seam's structured locators at admission
   * (V2.2 item 5.2, migration 0046): page/paragraph/sheet-cell positions, as a
   * JSON array of ReadLocator. NULL means no location: the source has no
   * segments (notes, chat, email, web), the span could not be found (the
   * honest empty from locateSpan), or the row predates locators.
   */
  spanLocators: jsonb('span_locators').$type<ReadLocator[]>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type VerificationResultRow = typeof verificationResult.$inferSelect;
export type VerificationVerdict = (typeof verificationVerdictEnum.enumValues)[number];

/**
 * The uncertainty sub-reason type (migration 0039), shared with the memory
 * module's `memory.uncertainty_reason` column: ONE Postgres type, declared once
 * in SQL and mapped per module, the way `scope` already is (connectors declares
 * its own mapping of the same type).
 */
export const uncertaintyReasonEnum = pgEnum('uncertainty_reason', UNCERTAINTY_REASONS);

/** Local mapping of the memory-owned `scope` type — the connectors precedent. */
const scopeEnum = pgEnum('scope', MEMORY_SCOPES);

/**
 * The suppressed-fact log (V2.0 item 3.3, migration 0039): every automatic
 * decision that demoted or withheld an extracted fact, so "Cogeto resolved it
 * itself" stays inspectable and reportable instead of invisible.
 *
 * It is a first-class record, not a debug trail. The V2.2 source detail view
 * reads it and the V2.3 findings report summarises it, which is why it carries
 * the fact as extracted, its exact span, the sub-reason, and the verification
 * detail behind the decision rather than a log line.
 *
 * Two rules it inherits from memories rather than invents:
 *
 * - **Gating.** `owner_id`, `scope` and `sensitive` are copied from the source,
 *   and every read applies the identical scope + sensitive gate. An entry is
 *   exactly as visible as the memory it explains, no more.
 * - **Deletion.** Entries hold source-derived content and spans, so they go with
 *   their source through the deletion saga (via ingestion's `DerivedCascade`)
 *   and the receipt counts them. Retention is the life of the source: they are
 *   the evidence for a decision about it, and evidence that outlived a signed
 *   erasure receipt would make the receipt a lie.
 *
 * `memory_id` is set when the fact WAS admitted as uncertain and NULL when it
 * was not admitted at all — the one column that distinguishes the two sides of
 * the admission line.
 */
export const suppressedFactLog = pgTable(
  'suppressed_fact_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    scope: scopeEnum('scope').notNull(),
    sensitive: boolean('sensitive').notNull().default(false),
    /** Provenance, as plain text: the memory-owned `source_type` enum is not
     * ingestion's to depend on, and item 3.6 turns it into a registry. */
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    /** The claim exactly as the extractor produced it. */
    factContent: text('fact_content').notNull(),
    /** The extractor's fact kind; NULL when it produced none. */
    factKind: text('fact_kind'),
    /** The exact source substring the claim was drawn from. */
    sourceSpan: text('source_span').notNull(),
    reason: uncertaintyReasonEnum('reason').notNull(),
    /** The verification detail behind the decision; NULL when no verification
     * ran (a structurally invalid fact never reaches the verifier). */
    verificationVerdict: verificationVerdictEnum('verification_verdict'),
    verificationReason: text('verification_reason'),
    promptVersion: text('prompt_version'),
    /**
     * Set when admitted as uncertain; NULL when the fact was not admitted.
     * The column FKs with ON DELETE CASCADE rather than SET NULL, because this
     * NULL carries meaning: nulling it on erasure would rewrite an admitted
     * fact's history into a withheld one, and would leave a rejected
     * extraction's content behind after the user removed its row.
     */
    memoryId: uuid('memory_id'),
    /** The span's structured locators, exactly as on `verification_result`
     * (V2.2 item 5.2): a withheld fact's position is evidence too. */
    spanLocators: jsonb('span_locators').$type<ReadLocator[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('suppressed_fact_source_idx').on(t.sourceType, t.sourceId),
    index('suppressed_fact_owner_created_idx').on(t.ownerId, t.createdAt),
    index('suppressed_fact_reason_idx').on(t.reason),
  ],
);

export type SuppressedFactRow = typeof suppressedFactLog.$inferSelect;

/**
 * The per-source extraction gate (V2.1 item 4.3, migration 0042, spec 1.6):
 * admission control over extraction, per owner and source type, enforced by the
 * pipeline before any model spend. An ABSENT gate row is today's behaviour,
 * byte-identical: enabled, registry fact budget, no retention. Dimensions and
 * effects are plain text validated in code (the source-type-registry precedent,
 * spec 15.3), so 'channel' and 'folder' need no migration when connectors and
 * bulk import arrive.
 */
export const extractionGate = pgTable(
  'extraction_gate',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    sourceType: text('source_type').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** NULL: the source-type registry's budget (and the parse cap) decide. */
    factBudget: integer('fact_budget'),
    /** NULL: facts live until their own validity or a transition ends them. */
    retentionDays: integer('retention_days'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('extraction_gate_owner_type_idx').on(t.ownerId, t.sourceType)],
);

export const extractionGateRule = pgTable(
  'extraction_gate_rule',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    sourceType: text('source_type').notNull(),
    dimension: text('dimension').notNull(),
    value: text('value').notNull(),
    effect: text('effect').$type<'allow' | 'deny'>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('extraction_gate_rule_owner_idx').on(t.ownerId, t.sourceType, t.dimension, t.value),
  ],
);

/**
 * The honest refusal ledger, mirroring email_refusal: a source the gate blocked
 * must not look processed-with-zero-facts. Metadata only, NEVER content; pruned
 * after 30 days by the nightly job, and erased with its source through
 * ingestion's cascade so no dangling provenance reference outlives a receipt.
 */
export const extractionGateRefusal = pgTable(
  'extraction_gate_refusal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    reason: text('reason').$type<ExtractionRefusalReason>().notNull(),
    /** The detected class the decision was made on, when a class rule made it. */
    documentClass: text('document_class'),
    refusedAt: timestamp('refused_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('extraction_gate_refusal_owner_idx').on(t.ownerId, t.refusedAt),
    index('extraction_gate_refusal_source_idx').on(t.sourceType, t.sourceId),
  ],
);

export type ExtractionRefusalReason =
  'extraction_disabled' | 'source_disabled' | 'document_class_denied';

export type ExtractionGateRow = typeof extractionGate.$inferSelect;
export type ExtractionGateRuleRow = typeof extractionGateRule.$inferSelect;
export type ExtractionGateRefusalRow = typeof extractionGateRefusal.$inferSelect;

/** One anchored subject: the name as the document gives it, plus whether the
 * anchor call (or the editing user) was confident about it. */
export interface SourceContextSubject {
  name: string;
  confident: boolean;
}

/**
 * The source context (V2.1 item 4.2, migration 0043, spec 1.5): what the
 * document as a whole is about, produced by the anchoring call over its
 * opening and filename, stored once per source and injected into every
 * chunk's extraction call. Content-bearing (subjects and revision are the
 * document's own words), so it joins the deletion cascade. A user-edited row
 * (`edited_by_user`) is authoritative: the anchor call never overwrites it.
 */
export const sourceContext = pgTable(
  'source_context',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    subjects: jsonb('subjects').$type<SourceContextSubject[]>().notNull().default([]),
    documentClass: text('document_class'),
    documentClassConfident: boolean('document_class_confident').notNull().default(false),
    revision: text('revision'),
    revisionConfident: boolean('revision_confident').notNull().default(false),
    editedByUser: boolean('edited_by_user').notNull().default(false),
    /** The anchoring prompt that produced a machine context; NULL once edited. */
    promptVersion: text('prompt_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('source_context_source_idx').on(t.sourceType, t.sourceId),
    index('source_context_owner_idx').on(t.ownerId),
  ],
);

export type SourceContextRow = typeof sourceContext.$inferSelect;

/**
 * The dreaming cycle's tables (migration 0012). Ingestion-owned
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

/**
 * The honest per-source pipeline stage (V2.2 item 5.1, migration 0045):
 * reading, extracting, verifying, storing. Upserted OUTSIDE the job
 * transaction (the file_read_report precedent), metadata only, one row per
 * source, erased with the source through ingestion's deletion cascade.
 */
export const ingestionProgress = pgTable(
  'ingestion_progress',
  {
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    stage: text('stage').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sourceType, t.sourceId] })],
);

export type IngestionProgressRow = typeof ingestionProgress.$inferSelect;

/**
 * The document revision link (V2.2 item 5.3, migration 0047; decision record
 * in docs/features/revisions.md): an explicit supersedes-source relationship
 * with its measured basis, inspectable and reversible. A rejected pair is
 * remembered by its unique row and never re-proposed. Rows leave with either
 * source through ingestion's deletion cascade.
 */
export const sourceRevision = pgTable(
  'source_revision',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    successorType: text('successor_type').notNull(),
    successorId: text('successor_id').notNull(),
    predecessorType: text('predecessor_type').notNull(),
    predecessorId: text('predecessor_id').notNull(),
    status: text('status')
      .$type<'auto' | 'proposed' | 'confirmed' | 'rejected' | 'manual'>()
      .notNull(),
    basisJson: jsonb('basis_json').$type<RevisionBasis>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('source_revision_pair_idx').on(
      t.ownerId,
      t.successorType,
      t.successorId,
      t.predecessorType,
      t.predecessorId,
    ),
    index('source_revision_predecessor_idx').on(t.predecessorType, t.predecessorId),
  ],
);

/**
 * The judged-pair ledger (V2.3 item 6.1, migration 0048): every
 * reconciliation verdict — model or deterministic — persisted with the prompt
 * version, model configuration, similarity at judgment time and timestamp.
 * An unchanged pair is never re-judged, so a borderline `compatible` cannot
 * flip to `contradicted` days later from sampling variance, the nightly
 * re-judging token cost is gone, and near-miss decisions leave an audit
 * trace. No content: the verdict is a decision about two rows, and the rows
 * carry the words. FK CASCADE erases the entry with either fact — a
 * successor is a new id, so a superseded pair simply never recurs.
 */
export const checkedPair = pgTable(
  'checked_pair',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    aMemoryId: uuid('a_memory_id').notNull(),
    bMemoryId: uuid('b_memory_id').notNull(),
    family: text('family').$type<'dedup' | 'contradiction'>().notNull(),
    verdict: text('verdict').notNull(),
    direction: text('direction'),
    /** Normalized [0,1]; NULL when the pair reached the check unscored. */
    similarity: real('similarity'),
    /** 'deterministic:<rule>' when no model was asked (quantity reasoning). */
    promptVersion: text('prompt_version').notNull(),
    modelConfig: text('model_config').notNull(),
    configVersion: integer('config_version').notNull(),
    judgedAt: timestamp('judged_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('checked_pair_a_idx').on(t.aMemoryId), index('checked_pair_b_idx').on(t.bMemoryId)],
);

export type CheckedPairRow = typeof checkedPair.$inferSelect;

/**
 * The growable entity-alias set (V2.3 item 6.1, migration 0048): recorded
 * name equivalences behind alias-aware pairing. Cross-language identity is
 * data — no folding rule knows the Croatian name of an English company.
 * Owner-scoped vocabulary (not source-derived content): rows live until the
 * owner removes them, and the reconciliation candidate gate is their one
 * consumer. Surface on Settings, the extraction-gate precedent.
 */
export const entityAlias = pgTable(
  'entity_alias',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    canonical: text('canonical').notNull(),
    alias: text('alias').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('entity_alias_owner_idx').on(t.ownerId)],
);

export type EntityAliasRow = typeof entityAlias.$inferSelect;

/** Every measured signal behind a revision decision. Metadata, never content
 * beyond the values the documents themselves anchored. */
export interface RevisionBasis {
  filename: string | null;
  revisionNew: string | null;
  revisionOld: string | null;
  subjectOverlap: number | null;
  classMatch: boolean | null;
  shingleSimilarity: number | null;
  confidence: 'high' | 'medium' | 'manual';
  /**
   * V2.5 item 8.1: the upstream itself asserted "same item, new content"
   * (stable natural key, changed content hash), evidence stronger than a
   * filename match. Present only on links the connector platform recorded.
   */
  upstreamIdentity?: string | null;
}

export type SourceRevisionRow = typeof sourceRevision.$inferSelect;
