import {
  bigint,
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  FACT_KINDS,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  RELATION_RESOLUTIONS,
  UNCERTAINTY_REASONS,
} from '@cogeto/shared';
import type { RelationDetector, RelationEvent, SourceTypeKey } from '@cogeto/shared';

/**
 * Tables owned by the memory module (migration 0001; as amended by 0003).
 * Module-private: never importable from another module (dependency-cruiser
 * persistence rule). All access goes through the MemoryStore public interface.
 */

export const scopeEnum = pgEnum('scope', MEMORY_SCOPES);
export const memoryStatusEnum = pgEnum('memory_status', MEMORY_STATUSES);

/**
 * Source types are REGISTERED, not enumerated in a database type (spec §15.3;
 * migration 0040 converted the columns to text). The vocabulary, the defunct
 * list, and every per-type property live in the source-type registry
 * (`@cogeto/shared/src/source-types.ts`); the deletion saga validates at the
 * API boundary and the integrity sweep flags any stored value the registry
 * does not know. Adding a source type therefore needs no migration here and
 * no edit in this module.
 */

/**
 * Why a memory is `uncertain` rather than `active` (V2.0 item 3.3, migration
 * 0039). The same Postgres type ingestion maps for its suppressed-fact log.
 */
export const uncertaintyReasonEnum = pgEnum('uncertainty_reason', UNCERTAINTY_REASONS);

export const receiptStatusEnum = pgEnum('receipt_status', ['pending', 'confirmed']);
export const factKindEnum = pgEnum('fact_kind', FACT_KINDS);
export const memoryRelationKindEnum = pgEnum('memory_relation_kind', ['contradicts']);
export const memoryRelationResolutionEnum = pgEnum(
  'memory_relation_resolution',
  RELATION_RESOLUTIONS,
);

export const memory = pgTable(
  'memory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    scope: scopeEnum('scope').notNull(),
    sourceType: text('source_type').$type<SourceType>().notNull(),
    sourceId: text('source_id').notNull(),
    status: memoryStatusEnum('status').notNull().default('active'),
    /**
     * WHY this fact was admitted `uncertain` (migration 0039, V2.0 item 3.3):
     * the named sub-reason that replaced the single undifferentiated bucket.
     * NULL means it was never admitted uncertain.
     *
     * Written once, at admission, and never rewritten. It is the admission
     * record, not a mirror of the current status: a fact the user later confirms
     * was still admitted for a reason, and the findings report says which. That
     * also keeps it out of the way of every status transition, including the
     * contradiction lift that restores a recorded prior status.
     *
     * It lives on the memory row rather than only in ingestion's
     * `verification_result` because Sources and the findings report read facts
     * through the gated MemoryStore, and ingestion's tables are module-private:
     * without the column the only way to render a reason is one gated
     * round-trip per fact (what the old Review queue did). The verification row
     * stays the EVIDENCE (verdict, the verifier's wording, the span, the prompt
     * version); this column is the DECISION, exactly as `status` is.
     */
    uncertaintyReason: uncertaintyReasonEnum('uncertainty_reason'),
    sensitive: boolean('sensitive').notNull().default(false),
    /**
     * Extracted entities, flat. The generated
     * content_tsv column and the trigram/tsvector indexes are deliberately not
     * mapped — they are query-side artifacts of migration 0005, referenced via
     * raw SQL in the search primitives only.
     */
    entities: text('entities').array().notNull().default([]),
    /** Raw temporal phrases code could not resolve (migration 0007). */
    temporalUnresolved: text('temporal_unresolved').array().notNull().default([]),
    /** The entity this fact is primarily ABOUT (migration 0008; F1/F4). NULL pre-v0002. */
    subjectEntity: text('subject_entity'),
    /** The extractor's fact kind (migration 0011). NULL pre-F2. */
    kind: factKindEnum('kind'),
    /**
     * Email-path authorship (migration 0030): true when the fact
     * came from the new content of a message the user wrote or sent themselves,
     * false when it is someone else's words (inbound sender, forwarded
     * original), NULL when unknown or not applicable (non-email sources).
     * Structural provenance metadata: true = the user wrote this text.
     */
    authoredByUser: boolean('authored_by_user'),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    supersededBy: uuid('superseded_by'),
    content: text('content'),
    contentEmbeddingRef: text('content_embedding_ref'),
    /** Which embed model produced the Qdrant point; NULL = not embedded (0004). */
    embeddingModel: text('embedding_model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('memory_owner_scope_idx').on(t.ownerId, t.scope),
    index('memory_status_idx').on(t.status),
    index('memory_source_idx').on(t.sourceType, t.sourceId),
  ],
);

export const fileMetadata = pgTable('file_metadata', {
  objectKey: text('object_key').primaryKey(),
  ownerId: text('owner_id').notNull(),
  scope: scopeEnum('scope').notNull(),
  sensitive: boolean('sensitive').notNull().default(false),
  uploadDate: timestamp('upload_date', { withTimezone: true }).notNull().defaultNow(),
  checksum: text('checksum'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
});

export const deletionReceipt = pgTable('deletion_receipt', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceType: text('source_type').$type<SourceType>().notNull(),
  sourceId: text('source_id').notNull(),
  countsJson: jsonb('counts_json'),
  status: receiptStatusEnum('status').notNull().default('pending'),
  prevHash: text('prev_hash'),
  hash: text('hash'),
  /** ed25519 signature over `hash`, base64 (spec §11.1; migration 0009). */
  signature: text('signature'),
  signedAt: timestamp('signed_at', { withTimezone: true }),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
});

/**
 * Discrepancies found by the nightly integrity sweep (spec §11.1 step 4, migration
 * 0010). The dedupe unique index (expression-based, not mapped here) makes
 * re-detection idempotent: one row per (receipt, kind, identifier), however
 * many runs re-find it.
 */
export const integrityAlert = pgTable('integrity_alert', {
  id: uuid('id').primaryKey().defaultRandom(),
  receiptId: uuid('receipt_id'),
  kind: text('kind').notNull(),
  detail: text('detail').notNull(),
  detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Pairs of memories reconciliation flagged (migration 0011;
 * ruling 2). `a` is the incoming (newer) fact at detection time, `b` the
 * existing one; prior statuses enable dismiss-restoration. Any row — resolved
 * or not — is a permanent tombstone: the pair is never re-detected. The
 * canonical-pair unique index (least/greatest expression) is not mapped here;
 * inserts rely on it via ON CONFLICT DO NOTHING.
 */
export const memoryRelation = pgTable(
  'memory_relation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: memoryRelationKindEnum('kind').notNull(),
    aMemoryId: uuid('a_memory_id').notNull(),
    bMemoryId: uuid('b_memory_id').notNull(),
    aPriorStatus: memoryStatusEnum('a_prior_status').notNull(),
    bPriorStatus: memoryStatusEnum('b_prior_status').notNull(),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    /** The model's explanation of the conflict (migration 0020): lives on
     * this owner-gated row — NEVER in the org-readable audit trail — and is
     * erased with the pair (FK CASCADE). NULL on pre-0020 rows. */
    reason: text('reason'),
    /** Which pass found it (migration 0048): pipeline, dreaming, or repair.
     * NULL on pre-0048 rows means "not recorded", never a guess. */
    detectedBy: text('detected_by').$type<RelationDetector>(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolution: memoryRelationResolutionEnum('resolution'),
  },
  (t) => [
    index('memory_relation_a_idx').on(t.aMemoryId),
    index('memory_relation_b_idx').on(t.bMemoryId),
  ],
);

/**
 * The finding's append-only history (V2.3 item 6.1, migration 0048;
 * docs/features/findings.md): detection, party replacement under
 * supersession, both resolution paths, kept-open records, reopening. The
 * report's delta view renders these. Structural metadata only in
 * `detail_json` (ids, sides, pass names, resolution values) — never content;
 * FK CASCADE erases the history with its finding.
 */
export const memoryRelationEvent = pgTable(
  'memory_relation_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    relationId: uuid('relation_id').notNull(),
    event: text('event').$type<RelationEvent>().notNull(),
    detailJson: jsonb('detail_json'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('memory_relation_event_relation_idx').on(t.relationId, t.createdAt)],
);

export type MemoryRow = typeof memory.$inferSelect;
export type MemoryRelationRow = typeof memoryRelation.$inferSelect;
export type MemoryRelationEventRow = typeof memoryRelationEvent.$inferSelect;
/** The registry's closed union — the compile-time half of the old enum's guarantee. */
export type SourceType = SourceTypeKey;
