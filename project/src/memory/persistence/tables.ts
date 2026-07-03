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
import { MEMORY_SCOPES, MEMORY_STATUSES } from '@cogeto/shared';

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
  signedAt: timestamp('signed_at', { withTimezone: true }),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
});

export type MemoryRow = typeof memory.$inferSelect;
export type SourceType = (typeof sourceTypeEnum.enumValues)[number];
