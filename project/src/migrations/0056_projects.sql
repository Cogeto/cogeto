-- 0056: projects as workspaces (V2.5 item 8.3).
--
-- Decision record: docs/features/projects.md, frozen before this migration.
-- The rule that governs every line here: PROJECTS ARE ORGANISATION AND
-- FILTERING, NEVER AUTHORISATION. There is deliberately NO project column on
-- `memory`, no project field in the Qdrant payload, and no third gate
-- dimension. A user's visibility of a fact stays decided by ownership, scope
-- and sensitivity alone. What a project holds is CONTAINERS, and the retrieval
-- lens is an additive pre-filter over source refs on top of the unchanged
-- gates.
--
-- project (owned by `projects`): the lightweight per-user record. Team-shared
-- projects are an explicit non-goal for this version, which is why there is no
-- membership table and no org column carrying authority: `org_id` is stamped
-- for the audit trail only, exactly as every other owner-scoped row stamps it.
-- `lens_enabled` and the three `extraction_*` columns are the only two
-- configurable behaviours a project has, and that shortness is deliberate: a
-- project is not a settings hierarchy.
--
-- project_assignment (owned by `projects`): what a project groups. Five kinds
-- through one table, because "which project is this in" must have exactly one
-- answer path. Identifiers and a kind ONLY: no filename, no title, no excerpt,
-- nothing source-derived, which is why deleting a source RELEASES an
-- assignment (the saga's enumeration transaction removes the row and counts it
-- on the receipt) rather than erasing content, and why deleting a project runs
-- no saga at all.
--
-- The unique index on (ref_type, ref_id) is the "at most one project per
-- thing" rule as a database constraint rather than a convention. ref_type is
-- the source type for `source` rows and the kind itself for the other four, so
-- one index covers all five without a partial-index-per-kind.
--
-- chat_message.lens (owned by `chat`): what the retrieval lens did for this
-- answer, so re-opening a conversation renders the same honest labels it
-- showed live. Identifiers and booleans only, never a project NAME and never
-- content, so it is outside the answer-redaction cascade's content overwrite
-- and row deletion takes it implicitly.
--
-- Reversal: DROP the two tables and the chat_message column below. Nothing
-- else in the schema references them, by design: a project is a folder over
-- rows that do not know they are in it.

CREATE TABLE project (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  org_id text,
  name text NOT NULL,
  description text,
  -- A design-system colour token key ('accent', 'sage', ...), never a hex
  -- value: the palette is the theme's, and a stored hex would outlive it.
  marker text,
  archived boolean NOT NULL DEFAULT false,
  -- Whether conversations in this project narrow retrieval by default.
  lens_enabled boolean NOT NULL DEFAULT true,
  -- The per-project extraction policy. NULL everywhere means "no project
  -- opinion", which folds into the gate arithmetic as no bound at all, so an
  -- unconfigured project is byte-identical to no project.
  extraction_enabled boolean,
  extraction_fact_budget integer,
  extraction_retention_days integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One "Client A" per owner: two folders with the same name diverge silently,
-- and the whole value of a project is knowing which one you are in.
CREATE UNIQUE INDEX project_owner_name_idx ON project (owner_id, lower(name));
CREATE INDEX project_owner_idx ON project (owner_id, archived, updated_at DESC);

CREATE TABLE project_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  kind text NOT NULL CHECK (
    kind IN ('source', 'conversation', 'research_run', 'connector_sub_scope', 'findings_report')
  ),
  ref_type text NOT NULL,
  ref_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX project_assignment_ref_idx ON project_assignment (ref_type, ref_id);
CREATE INDEX project_assignment_project_idx ON project_assignment (project_id, kind);
CREATE INDEX project_assignment_owner_idx ON project_assignment (owner_id, kind);

ALTER TABLE chat_message ADD COLUMN lens jsonb;
