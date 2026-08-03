import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Tables owned by the files module (migration 0041, V2.1 item 4.1).
 * Module-private: nothing outside `files/` may name them (spec §15 rule 2).
 *
 * `file_read_report` is what the reading layer made of an uploaded file. It
 * exists because two of the reader seam's guarantees are promises to a HUMAN,
 * and a promise nobody can see is not kept:
 *
 * - a reader that fails "fails loudly and locally", with a reason, rather than
 *   leaving a file that says only `error`;
 * - a spreadsheet truncated at the row cap says so, so nobody believes they got
 *   the whole file when they got part of it.
 *
 * It is keyed by OBJECT KEY rather than by a file_metadata row on purpose:
 * extract-and-discard uploads never have a metadata row, and they are exactly
 * the uploads whose original is gone, so the read report may be the only
 * remaining evidence of what happened. Written OUTSIDE the pipeline's
 * transaction, because the failure case is a transaction that rolls back.
 *
 * Content-bearing (sheet names are the document's own words), therefore in the
 * deletion cascade: `FileReadReportCascade` implements memory's DerivedCascade
 * and the saga erases the row with the source.
 */
export const fileReadReport = pgTable(
  'file_read_report',
  {
    /** The object key, which IS the file source id (1:1, F1 handoff). */
    objectKey: text('object_key').primaryKey(),
    ownerId: text('owner_id').notNull(),
    /** The reader that ran, or null when none could be selected. */
    format: text('format'),
    /** read | truncated | empty | unsupported_format | read_failed. */
    outcome: text('outcome').notNull(),
    /** The specific reason; an enum value the SPA maps to translated copy. */
    reasonCode: text('reason_code'),
    /** Counts and per-sheet accounting. Never model output, never a fact. */
    detailJson: jsonb('detail_json').notNull().default({}),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('file_read_report_owner_idx').on(t.ownerId)],
);

export type FileReadReportRow = typeof fileReadReport.$inferSelect;
