import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { MemoryScope } from '@cogeto/shared';

/**
 * Tables owned by the imports context (V2.2 item 5.3, migration 0047).
 * Module-private. An import is a first-class record: its manifest, options,
 * counts, state and per-file outcomes. Items carry filenames, which makes
 * them content-adjacent: the deletion cascade tombstones an item when its
 * ingested source is erased (name cleared, arithmetic kept).
 */

export const importRun = pgTable(
  'import_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    /** The owner's org: the coordinator mints final object keys with it. */
    orgId: text('org_id').notNull(),
    /** The space every document this run ingests lands in
     * (docs/features/spaces.md, migration 0060), stamped at run creation
     * from the caller's current space. Items inherit through the run. */
    spaceId: uuid('space_id').notNull(),
    kind: text('kind').$type<'zip' | 'folder' | 's3'>().notNull(),
    state: text('state')
      .$type<'manifest' | 'running' | 'completed' | 'cancelled' | 'failed'>()
      .notNull()
      .default('manifest'),
    /** Non-secret options only; S3 credentials are never stored. */
    optionsJson: jsonb('options_json').$type<ImportRunOptions>(),
    /** The completion summary's real numbers, written once at finalize. */
    countsJson: jsonb('counts_json').$type<ImportRunCounts>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('import_run_owner_created_idx').on(t.ownerId, t.createdAt)],
);

export const importItem = pgTable(
  'import_item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => importRun.id, { onDelete: 'cascade' }),
    ownerId: text('owner_id').notNull(),
    /** Relative path inside the folder/ZIP/prefix; NULL once tombstoned. */
    name: text('name'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    contentType: text('content_type'),
    contentHash: text('content_hash'),
    state: text('state')
      .$type<
        | 'listed'
        | 'excluded'
        | 'unsupported'
        | 'duplicate'
        | 'queued'
        | 'ingested'
        | 'failed'
        | 'cancelled'
        | 'tombstoned'
      >()
      .notNull()
      .default('listed'),
    /** The staging twin holding the bytes between confirm and ingestion. */
    stagingKey: text('staging_key'),
    /** The final source key once ingested (the file source's id). */
    objectKey: text('object_key'),
    /** Reason code for unsupported/failed items; never content. */
    reason: text('reason'),
    /** The existing source this item's filename nominates as a predecessor
     * (same normalized name, different hash): the revision candidate. */
    revisionOf: text('revision_of'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('import_item_run_idx').on(t.runId, t.state),
    index('import_item_object_key_idx').on(t.objectKey),
  ],
);

/** Non-secret run options, as stored. */
export interface ImportRunOptions {
  /** A human label for where this came from (zip name, folder name, s3 url + prefix). */
  sourceLabel?: string;
  /** Why the coordinator is currently waiting, when it is (daily cap). */
  pausedReason?: string | null;
  /** The scope the whole run ingests under, chosen at confirm (issue #490).
   * Absent on runs confirmed before the choice existed: the coordinator then
   * falls back to 'private', which is what those runs actually did. */
  scope?: MemoryScope;
  /** Chosen at confirm beside the scope; absent means false. */
  sensitive?: boolean;
}

/** The completion summary's shape. Every number is real. */
export interface ImportRunCounts {
  documents: number;
  facts: number;
  contradictions: number;
  superseded: number;
  duplicatesSkipped: number;
  revisionsLinked: number;
  revisionsProposed: number;
  unreadable: number;
  gated: number;
  truncated: number;
  failed: number;
  excluded: number;
  unsupported: number;
  cancelled: number;
}

export type ImportRunRow = typeof importRun.$inferSelect;
export type ImportItemRow = typeof importItem.$inferSelect;
