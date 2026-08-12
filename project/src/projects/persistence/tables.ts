import { boolean, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { ProjectAssignmentKind, ProjectMarker } from '@cogeto/shared';

/**
 * Tables owned by the `projects` module (V2.5 item 8.3, migration 0056).
 * Module-private.
 *
 * The property worth stating at the top of the file, because it is the one a
 * future change will be tempted to break: NEITHER TABLE IS SOURCE-DERIVED.
 * `project` holds the user's own words (a name, a description) and their own
 * choices; `project_assignment` holds identifiers and a kind. Nothing here is
 * extracted, quoted, or copied out of a document, which is why a deletion
 * receipt has nothing to erase in this module and everything to RELEASE.
 *
 * Decision record: docs/features/projects.md.
 */

export const project = pgTable(
  'project',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull(),
    /** Stamped for the audit trail; it carries no authority (per-user only). */
    orgId: text('org_id'),
    name: text('name').notNull(),
    description: text('description'),
    /** A design-system colour token key, never a hex value. */
    marker: text('marker').$type<ProjectMarker>(),
    archived: boolean('archived').notNull().default(false),
    /** Conversations in this project narrow retrieval to its sources. */
    lensEnabled: boolean('lens_enabled').notNull().default(true),
    /** The whole per-project extraction policy. NULL = no project opinion. */
    extractionEnabled: boolean('extraction_enabled'),
    extractionFactBudget: integer('extraction_fact_budget'),
    extractionRetentionDays: integer('extraction_retention_days'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('project_owner_idx').on(t.ownerId, t.archived, t.updatedAt)],
);

/**
 * What a project groups. Identifiers only.
 *
 * `refType` is the SOURCE TYPE for `source` rows and the kind itself for the
 * other four, so the unique index on (ref_type, ref_id) expresses "at most one
 * project per thing" for all five kinds without a partial index per kind.
 */
export const projectAssignment = pgTable(
  'project_assignment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    ownerId: text('owner_id').notNull(),
    kind: text('kind').$type<ProjectAssignmentKind>().notNull(),
    refType: text('ref_type').notNull(),
    refId: text('ref_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('project_assignment_project_idx').on(t.projectId, t.kind),
    index('project_assignment_owner_idx').on(t.ownerId, t.kind),
  ],
);

export type ProjectRow = typeof project.$inferSelect;
export type ProjectAssignmentRow = typeof projectAssignment.$inferSelect;
