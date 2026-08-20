import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { FindingsReportCountsDto, ReportProgressDto, ReportScopeDto } from '@cogeto/shared';

/**
 * Tables owned by the reports context (V2.3 item 6.2, migration 0049).
 * Module-private. One row is one findings run: scope, requester, model
 * configuration, counts, and pointers to the two rendered artifacts. The row
 * outlives its artifacts (the delta view needs the run record after retention
 * or the deletion cascade has erased the content-bearing files), so nothing
 * here may ever carry quoted content.
 */

export const findingsReport = pgTable(
  'findings_report',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    orgId: text('org_id'),
    /** The space the run enumerates within (docs/features/spaces.md,
     * migration 0060): a findings run is space-bounded by construction, since
     * every gated read during assembly rides a principal carrying this. */
    spaceId: uuid('space_id').notNull(),
    status: text('status')
      .$type<'pending' | 'running' | 'ready' | 'failed' | 'expired'>()
      .notNull()
      .default('pending'),
    reportVersion: text('report_version').notNull(),
    locale: text('locale').notNull().default('en'),
    scopeJson: jsonb('scope_json').$type<ReportScopeDto>().notNull(),
    /** canonicalize(scope_json): the indexed identity of "the same scope". */
    scopeKey: text('scope_key').notNull(),
    modelConfigId: text('model_config_id'),
    previousReportId: uuid('previous_report_id'),
    countsJson: jsonb('counts_json').$type<FindingsReportCountsDto>(),
    /** Metadata-only progress, upserted OUTSIDE the job transaction. */
    progressJson: jsonb('progress_json').$type<ReportProgressDto>(),
    jsonObjectKey: text('json_object_key'),
    pdfObjectKey: text('pdf_object_key'),
    jsonSizeBytes: bigint('json_size_bytes', { mode: 'number' }),
    pdfSizeBytes: bigint('pdf_size_bytes', { mode: 'number' }),
    /** sha256 hex of the canonical payload; what the signature covers. */
    payloadSha256: text('payload_sha256'),
    signature: text('signature'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    index('findings_report_user_idx').on(table.userId, table.createdAt),
    index('findings_report_retention_idx').on(table.status, table.expiresAt),
    index('findings_report_scope_idx').on(table.userId, table.scopeKey, table.createdAt),
  ],
);

export type FindingsReportRow = typeof findingsReport.$inferSelect;
