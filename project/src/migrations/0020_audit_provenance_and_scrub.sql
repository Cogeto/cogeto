-- Migration 0020 — audit-log content hygiene + provenance (Session FIX-1,
-- findings QS-1/QS-13; decision 0025).
--
-- 1. audit_log.owner_id: which user's artifact the entry concerns. The reader
--    keeps its org gate for the ENTRY, but detail_json is returned only to the
--    owner (or for ownerless system entries) — detail visibility beyond
--    metadata requires ownership.
-- 2. memory_relation.reason: the model's contradiction explanation moves to
--    the owner-gated relation row (it names slot values from private
--    memories); it must never again live in the org-readable audit trail.
-- 3. Scrub: existing audit rows that carry a free-text `reason` key (model
--    sentences paraphrasing private memory content — QS-1) have that key
--    removed. This is a DELIBERATE, RECORDED redaction of leaked content
--    (decision 0025): the append-only trigger guards rows against application
--    code, not against a sanctioned migration; the trigger is disabled for
--    exactly this statement and re-enabled, and the scrub itself is audited.
--
-- Written idempotently (IF NOT EXISTS / re-runnable scrub) so the migration
-- test can replay it against legacy-shaped rows.

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS owner_id text;
ALTER TABLE memory_relation ADD COLUMN IF NOT EXISTS reason text;

DO $$
DECLARE
  scrubbed integer;
BEGIN
  ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_or_delete;
  UPDATE audit_log
     SET detail_json = detail_json - 'reason'
   WHERE detail_json ? 'reason';
  GET DIAGNOSTICS scrubbed = ROW_COUNT;
  ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update_or_delete;

  -- The scrub is itself part of the trail: how many rows were redacted, when,
  -- by which migration. Counts only — the removed text is gone, that is the point.
  IF scrubbed > 0 THEN
    INSERT INTO audit_log (actor, action, entity_type, entity_id, detail_json)
    VALUES (
      'migration:0020',
      'audit.detail_scrubbed',
      'audit_log',
      '0020_audit_provenance_and_scrub',
      jsonb_build_object('rows_scrubbed', scrubbed, 'keys_removed', jsonb_build_array('reason'))
    );
  END IF;
END;
$$;
