-- Migration 0037 — backfill `memory.authored_by_user` from provenance.
--
-- The open-loops read now enforces the first-person rule: an obligation is the
-- caller's only when the caller wrote the words it came from. That rule reads
-- `memory.authored_by_user`, which until now only the email path ever stamped.
-- Every note, chat capture, uploaded document and fetched page carries NULL, so
-- switching the filter on without this backfill would empty the attention feed
-- and the "what is still open" answer on every existing instance.
--
-- Authorship is structural, so it is derivable from provenance alone with no
-- re-extraction and no model call:
--
--   user_note  the user typed it                          -> true
--   chat       only USER messages are ever captured       -> true
--   file       a document is someone else's writing       -> false
--   web        a fetched page is someone else's writing   -> false
--   email      already correct where stamped; otherwise
--              resolved from email_message.authored_by_owner
--
-- Defunct source types (`task_conclusion`, `calendar_event`) are deliberately
-- absent: they have no rows and must not gain any.
--
-- Only NULL rows are touched. A value the pipeline already stamped is left
-- exactly as it is, so re-running this changes nothing.

UPDATE memory SET authored_by_user = true
WHERE authored_by_user IS NULL AND source_type IN ('user_note', 'chat');

UPDATE memory SET authored_by_user = false
WHERE authored_by_user IS NULL AND source_type IN ('file', 'web');

-- Email predates the flag on some rows. The intake recorded whether the message
-- came from the owner's own address; that is the same fact one level up, so it
-- resolves the remainder honestly rather than guessing. A message row that is
-- itself unknown (pre-0030) stays NULL: unknown stays unknown, and an unknown
-- obligation is not presented as the user's own.
UPDATE memory m SET authored_by_user = e.authored_by_owner
FROM email_message e
WHERE m.authored_by_user IS NULL
  AND m.source_type = 'email'
  AND m.source_id = e.id::text
  AND e.authored_by_owner IS NOT NULL;
