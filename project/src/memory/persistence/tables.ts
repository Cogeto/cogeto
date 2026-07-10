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
import { FACT_KINDS, MEMORY_SCOPES, MEMORY_STATUSES, RELATION_RESOLUTIONS } from '@cogeto/shared';

/**
 * Tables owned by the memory module (migration 0001; §A.6 as amended by 0003).
 * Module-private: never importable from another module (dependency-cruiser
 * persistence rule). All access goes through the MemoryStore public interface.
 */

export const scopeEnum = pgEnum('scope', MEMORY_SCOPES);
export const memoryStatusEnum = pgEnum('memory_status', MEMORY_STATUSES);
export const sourceTypeEnum = pgEnum('source_type', [
  'user_note',
  'chat',
  'email',
  'calendar_event',
  'file',
]);
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
    sourceType: sourceTypeEnum('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    status: memoryStatusEnum('status').notNull().default('active'),
    sensitive: boolean('sensitive').notNull().default(false),
    /**
     * Extracted entities, flat (decision 0006 ruling 2). The generated
     * content_tsv column and the trigram/tsvector indexes are deliberately not
     * mapped — they are query-side artifacts of migration 0005, referenced via
     * raw SQL in the search primitives only.
     */
    entities: text('entities').array().notNull().default([]),
    /** Raw temporal phrases code could not resolve (migration 0007, decision 0007). */
    temporalUnresolved: text('temporal_unresolved').array().notNull().default([]),
    /** The entity this fact is primarily ABOUT (migration 0008; F1/F4). NULL pre-v0002. */
    subjectEntity: text('subject_entity'),
    /** The extractor's fact kind (migration 0011; decision 0010). NULL pre-F2. */
    kind: factKindEnum('kind'),
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
  sourceType: sourceTypeEnum('source_type').notNull(),
  sourceId: text('source_id').notNull(),
  countsJson: jsonb('counts_json'),
  status: receiptStatusEnum('status').notNull().default('pending'),
  prevHash: text('prev_hash'),
  hash: text('hash'),
  /** ed25519 signature over `hash`, base64 (§B.1; migration 0009). */
  signature: text('signature'),
  signedAt: timestamp('signed_at', { withTimezone: true }),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
});

/**
 * Discrepancies found by the nightly integrity sweep (§A.7 step 4, migration
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
 * Pairs of memories reconciliation flagged (migration 0011; decision 0010
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
    /** The model's explanation of the conflict (migration 0020, QS-1): lives on
     * this owner-gated row — NEVER in the org-readable audit trail — and is
     * erased with the pair (FK CASCADE). NULL on pre-0020 rows. */
    reason: text('reason'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolution: memoryRelationResolutionEnum('resolution'),
  },
  (t) => [
    index('memory_relation_a_idx').on(t.aMemoryId),
    index('memory_relation_b_idx').on(t.bMemoryId),
  ],
);

export type MemoryRow = typeof memory.$inferSelect;
export type MemoryRelationRow = typeof memoryRelation.$inferSelect;
export type SourceType = (typeof sourceTypeEnum.enumValues)[number];
