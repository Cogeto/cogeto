-- 0023 — scrub false-positive orphaned_object alerts on retained emails
-- (issue #62). The sweep's orphan arm predated O4 email and validated bucket
-- objects only against file_metadata, so every retained email raw original /
-- externalised HTML body was flagged as an orphan on the first nightly sweep
-- after email capture. The sweep now consults the email adapter; alerts never
-- auto-clear, so this removes the historical false positives — ONLY those
-- whose flagged object key belongs to a LIVE email_message row (the detail
-- text begins with the object key). A genuinely orphaned email object (no
-- row) keeps its alert. Idempotent by construction.

DELETE FROM integrity_alert ia
WHERE ia.kind = 'orphaned_object'
  AND EXISTS (
    SELECT 1
    FROM email_message em
    WHERE ia.detail LIKE em.raw_object_key || ' %'
       OR (em.html_object_key IS NOT NULL AND ia.detail LIKE em.html_object_key || ' %')
  );
