-- Migration 0012 — the dreaming cycle (Session F2-B; decision 0011; §B.6 plain
-- form). Tables are ingestion-owned (dreaming is the consolidation half of the
-- pipeline); memory-referencing columns FK with ON DELETE CASCADE so erased
-- memories take their dream traces with them (the verification_result
-- precedent: the FK exists for the deletion cascade, never for joins).

-- One row per dreaming run: the watermark pair defines the incremental scope
-- ("the day's newly admitted facts and the memories they touch"), counts_json
-- summarizes the passes. finished_at NULL = crashed mid-run; the next run's
-- watermark comes from the last FINISHED run, so nothing is skipped.
CREATE TABLE dream_run (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  scope_from  timestamptz NOT NULL,
  scope_to    timestamptz NOT NULL,
  counts_json jsonb
);

CREATE INDEX dream_run_finished_idx ON dream_run (finished_at DESC) WHERE finished_at IS NOT NULL;

-- One row per action a run took — the digest's raw material and the audit
-- trail's index (the memory-level audit rows still exist independently).
CREATE TABLE dream_action (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES dream_run (id) ON DELETE CASCADE,
  -- dedup | contradiction | supersession | staleness | dormant
  pass              text NOT NULL,
  -- dedup: survivor · supersession: winner · contradiction: the incoming fact
  -- · staleness/dormant: the memory itself.
  memory_id         uuid NOT NULL REFERENCES memory (id) ON DELETE CASCADE,
  -- dedup: loser · supersession: loser · contradiction: the existing fact.
  related_memory_id uuid REFERENCES memory (id) ON DELETE CASCADE,
  relation_id       uuid REFERENCES memory_relation (id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX dream_action_run_idx ON dream_action (run_id);

-- Commitments that went quiet (decision 0011): flagged for the digest and for
-- the F3 task engine — NEVER a status transition. One open flag per memory;
-- dreaming clears flags whose memory left `active`, F3 clears on task closure.
CREATE TABLE dormant_flag (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id  uuid NOT NULL REFERENCES memory (id) ON DELETE CASCADE,
  run_id     uuid REFERENCES dream_run (id) ON DELETE SET NULL,
  reason     text NOT NULL,
  flagged_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz
);

CREATE UNIQUE INDEX dormant_flag_open_idx ON dormant_flag (memory_id) WHERE cleared_at IS NULL;
