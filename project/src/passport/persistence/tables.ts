import { bigint, boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Tables owned by the passport module (migration 0022). Module-private — the
 * artifact lives in object storage; this is only the request/status ledger the
 * SPA polls and the download endpoint authorizes against.
 */
export const passportExport = pgTable(
  'passport_export',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    orgId: text('org_id'),
    status: text('status').notNull().default('pending'),
    passportVersion: text('passport_version').notNull(),
    includeOriginals: boolean('include_originals').notNull().default(false),
    objectKey: text('object_key'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    index('passport_export_user_idx').on(table.userId, table.createdAt),
    index('passport_export_retention_idx').on(table.status, table.expiresAt),
  ],
);

export type PassportExportRow = typeof passportExport.$inferSelect;
