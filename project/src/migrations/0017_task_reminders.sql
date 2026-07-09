-- Migration 0017 — reminder state on the task table (Session O2-A; F3 handoff
-- §2, pre-approved additive columns). Reminders are NOT a new table: the state
-- is "is there a pending reminder of this kind for this task", one nullable
-- timestamp per trigger. The nightly reminders pass (graphile cron, one crontab
-- line — no second scheduler) stamps these once per window; the digest renders
-- tasks that carry a pending stamp; close/dismiss and dormancy-resolution clear
-- them. Idempotent by the same "stamp only when NULL" rule the pass uses.

ALTER TABLE task
  ADD COLUMN due_reminded_at     timestamptz,
  ADD COLUMN dormant_reminded_at timestamptz;

-- The reminders pass scans open/blocked tasks; a partial index keeps that scan
-- cheap as the settled history grows (mirrors task_due_idx).
CREATE INDEX task_reminder_scan_idx
  ON task (owner_id)
  WHERE status IN ('open', 'blocked_on_condition');
