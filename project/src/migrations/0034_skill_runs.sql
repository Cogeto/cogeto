-- Migration 0034 — named skills: the skill runtime (issues #261/#262/#263;
-- decision 0059).
--
-- A skill is a named, versioned, code-defined multi-step workflow (registry
-- like prompts: research_brief/v0001). One skill_run row records one
-- invocation; its skill_run_step rows ARE the inspectability claim — every
-- step's status, inputs/outputs summary, and links to everything it produced
-- (research runs, pages, memories, the brief), one click away, forever.
--
--   skill_run.status       — planning → awaiting_approval → running →
--                            completed (+ awaiting_input, failed, cancelled).
--                            The gate pause (awaiting_approval) is a stored
--                            state, not a live connection (orchestration
--                            patterns: the run resumes from the row alone).
--   skill_run.brief        — the durable brief artifact ([M#]/[W#] markers);
--                            brief_citations resolves them (memory ids, URLs +
--                            fetch times) so citation links stay live.
--   skill_run.proposed_actions — adoption proposals ONLY (decision 0054: a
--                            skill never creates a task; accepting one goes
--                            through POST /api/tasks/adopt). State per
--                            proposal: proposed | accepted | dismissed.
--   skill_run_step.links   — jsonb of produced-artifact references
--                            (researchRunIds, pageIds, memoryIds, counts).
--   skill_run_step UNIQUE (skill_run_id, step_key) — the per-step checkpoint
--                            claim the re-runnable advance job compare-and-sets.
--   research_run.skill_run_id — tags a research run as one query of a skill's
--                            approved plan. Same-module value reference (no
--                            FK, matching conversation_id's shape): skill runs
--                            are not deletable sources in v1, and the research
--                            run must outlive any future skill-run pruning —
--                            it IS the provenance record of what left.

CREATE TYPE skill_run_status AS ENUM (
  'planning',
  'awaiting_approval',
  'running',
  'awaiting_input',
  'completed',
  'failed',
  'cancelled'
);

CREATE TYPE skill_step_status AS ENUM (
  'pending',
  'running',
  'completed',
  'failed',
  'skipped'
);

CREATE TABLE skill_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  -- The owner's Zitadel organization, captured at propose time: the worker
  -- executes as the owner (search, capture) and §A.6 object keys need the
  -- real org segment there — a synthetic principal must not blank it.
  org_id text NOT NULL DEFAULT '',
  skill_id text NOT NULL,
  skill_version text NOT NULL,
  subject text NOT NULL,
  status skill_run_status NOT NULL DEFAULT 'planning',
  brief text,
  brief_citations jsonb,
  proposed_actions jsonb NOT NULL DEFAULT '[]',
  failure_reason text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX skill_run_owner_created_idx ON skill_run (owner_id, created_at);

CREATE TABLE skill_run_step (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_run_id uuid NOT NULL REFERENCES skill_run (id) ON DELETE CASCADE,
  position integer NOT NULL,
  step_key text NOT NULL,
  kind text NOT NULL,
  status skill_step_status NOT NULL DEFAULT 'pending',
  inputs_summary text,
  outputs_summary text,
  links jsonb NOT NULL DEFAULT '{}',
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (skill_run_id, step_key)
);

CREATE INDEX skill_run_step_run_idx ON skill_run_step (skill_run_id, position);

ALTER TABLE research_run ADD COLUMN skill_run_id uuid;

CREATE INDEX research_run_skill_run_idx ON research_run (skill_run_id);
