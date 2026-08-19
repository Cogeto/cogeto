import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { DEFAULT_SPACE_ID } from '@cogeto/shared';

/**
 * The provenance table owned by `confluence` (V2.5 item 8.2, migration
 * 0055): one row per materialized source, page or attachment, so a fact
 * traces to a specific VERSION of a specific page and links back to it.
 * Titles and space names are the document's own words, so the row is
 * content-bearing and joins the deletion cascade (ConfluencePageCascade),
 * erased with its source. The platform's item ledger deliberately carries
 * none of this.
 */
export const confluencePage = pgTable(
  'confluence_page',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    orgId: text('org_id').notNull(),
    /** The COGETO space (docs/features/spaces.md, migration 0060), inherited
     * from the connector at materialization. Not to be confused with the
     * Confluence space, which is `space_key` / `space_name` below. */
    spaceId: uuid('space_id').notNull().default(DEFAULT_SPACE_ID),
    connectorId: uuid('connector_id').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    kind: text('kind').$type<'page' | 'attachment'>().notNull(),
    pageId: text('page_id').notNull(),
    attachmentId: text('attachment_id'),
    title: text('title'),
    spaceKey: text('space_key'),
    spaceName: text('space_name'),
    version: integer('version'),
    url: text('url'),
    parentPageId: text('parent_page_id'),
    parentTitle: text('parent_title'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('confluence_page_source_idx').on(t.sourceType, t.sourceId),
    index('confluence_page_owner_idx').on(t.ownerId),
    index('confluence_page_connector_idx').on(t.connectorId),
  ],
);

export type ConfluencePageRow = typeof confluencePage.$inferSelect;
