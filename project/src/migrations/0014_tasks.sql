-- Migration 0014 — the task table + historical backfill (Session F3-B;
-- decision 0013). Tasks are DERIVED state: one row per deriving memory
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
  -- Derived from an uncertain memory; Review resolves it (decision 0013 r2).
  from_uncertain              boolean NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX task_owner_status_idx ON task (owner_id, status);
CREATE INDEX task_due_idx ON task (due) WHERE status IN ('open', 'blocked_on_condition');

-- One-shot historical backfill (decision 0013 ruling 2): enqueue the
-- idempotent tasks backfill job so pre-F3 commitments gain tasks. Guarded —
-- on a fresh clone the graphile schema does not exist yet at migrate time,
-- and there is nothing to backfill there anyway (the nightly dreaming cycle
-- also re-enqueues it, so nothing is ever missed).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'graphile_worker') THEN
    PERFORM graphile_worker.add_job(
      'tasks_backfill',
      json_build_object('source_type', 'tasks_backfill', 'source_id', 'migration-0014')::json
    );
  END IF;
END $$;
