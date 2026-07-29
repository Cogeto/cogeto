-- Migration 0014 — the task table + historical backfill (
--). Tasks are DERIVED state: one row per deriving memory
-- (UNIQUE), following the supersession chain head; the FK CASCADE is the
-- safety net under the deletion saga's counted port delete.

CREATE TYPE task_status AS ENUM ('open', 'blocked_on_condition', 'done', 'dismissed');

CREATE TABLE task (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id                    text NOT NULL,
  scope                       scope NOT NULL,
  derived_from_memory_id      uuid NOT NULL UNIQUE REFERENCES memory (id) ON DELETE CASCADE,
  title                       text NOT NULL,
  primary_person              text,
  entities                    text[] NOT NULL DEFAULT '{}',
  condition_text              text,
  condition_met               boolean NOT NULL DEFAULT false,
  condition_met_by_memory_id  uuid REFERENCES memory (id) ON DELETE SET NULL,
  due                         timestamptz,
  status                      task_status NOT NULL DEFAULT 'open',
  closed_by_memory_id         uuid REFERENCES memory (id) ON DELETE SET NULL,
  dormant                     boolean NOT NULL DEFAULT false,
  -- Derived from an uncertain memory; Review resolves it ( r2).
  from_uncertain              boolean NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX task_owner_status_idx ON task (owner_id, status);
CREATE INDEX task_due_idx ON task (due) WHERE status IN ('open', 'blocked_on_condition');

-- NEUTRALIZED in 2.0. This migration once enqueued the
-- one-shot `tasks_backfill` job here. The job type no
-- longer exists: leaving the enqueue would park a permanently failing job on
-- every fresh database, since migrations replay from 0001. The schema above is
-- untouched — it still creates exactly what it always created, and migration
-- 0035 drops it again — so replaying the file remains correct; only the
-- side effect on a queue that no longer has a handler is removed.
