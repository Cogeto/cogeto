-- 0041: the file read report (V2.1 item 4.1, the reading layer).
--
-- What the reading layer made of an uploaded file, so that two of the reader
-- seam's guarantees are visible to the person who uploaded it rather than only
-- true inside the worker:
--
--   1. A reader that fails fails LOUDLY and LOCALLY. Before this, a file whose
--      bytes could not be parsed reached `error` through the dead-letter table
--      and said nothing else; "Cogeto does not read this kind of file" and
--      "Cogeto reads this kind of file and could not read yours" were the same
--      screen. `outcome` separates them and `reason_code` names the case.
--   2. A spreadsheet truncated at the row cap SAYS SO. A fifty-thousand-row
--      export is read up to the configured cap; a user who is not told that has
--      been quietly given part of a file and told it was all of it.
--
-- Keyed by object key, not by file_metadata.id, and deliberately NOT a foreign
-- key to it: extract-and-discard uploads (F1 handoff §3) never have a metadata
-- row at all, and they are precisely the uploads whose original is deleted after
-- extraction, so this row can be the only surviving evidence of what was read.
--
-- Written OUTSIDE the pipeline transaction. The failure case is a transaction
-- that rolls back, so a report written inside it would roll back with the
-- failure it exists to record.
--
-- `detail_json` holds counts and per-sheet accounting only: rows read, rows
-- present, which sheets truncated, how many cells had no recoverable value, and
-- the CSV delimiter and encoding that detection settled on. Sheet NAMES are in
-- there, and a sheet name is the document's own words, which is why this table
-- is in the deletion cascade (files registers a DerivedCascade; the saga erases
-- the row with its source and counts it in the receipt as `file_read_reports`).

CREATE TABLE file_read_report (
  object_key   text PRIMARY KEY,
  owner_id     text NOT NULL,
  format       text,
  outcome      text NOT NULL,
  reason_code  text,
  detail_json  jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX file_read_report_owner_idx ON file_read_report (owner_id);
