-- 0048: contradiction coverage overhaul + findings lifecycle (V2.3 item 6.1).
--
-- checked_pair (owned by ingestion): the judged-pair ledger. Every model (or
-- deterministic) reconciliation verdict is persisted with the prompt version,
-- model configuration, similarity at judgment time and timestamp, so an
-- unchanged pair is never re-judged: the nightly pass cannot flip a borderline
-- verdict days later from sampling variance alone, the recurring token cost is
-- gone, and near-miss decisions leave an audit trace. A pair "changes" only by
-- one of its rows being superseded (a successor is a NEW id, so the old pair
-- simply never recurs) or by the prompt/model configuration changing (the
-- stored columns disagree with the active ones, which re-opens the pair).
-- Rows carry no content; FK CASCADE erases them with either fact.
--
-- entity_alias (owned by ingestion, the extraction-gate precedent: table and
-- API in ingestion, surface on Settings): the growable alias set behind
-- entity pairing. Cross-language subjects (a company known by a Croatian and
-- an English name) can only be paired by a recorded equivalence; folding and
-- suffix rules are code, aliases are data. Owner-scoped vocabulary, not
-- source-derived content: rows live until the owner removes them.
--
-- memory_relation gains detected_by (which pass found the finding: pipeline,
-- dreaming, repair; NULL on pre-0048 rows means "not recorded", never a
-- guess) and the resolution enum gains 'revision' for the findings lifecycle
-- (docs/features/findings.md): a finding a supersession settled, recorded
-- uniformly with the owner-resolved ones.
--
-- memory_relation_event (owned by memory): the finding's append-only history.
-- The report's delta view (item 6.2) renders these; reopening restores an
-- earlier finding rather than minting a new one, so a corpus that regresses
-- shows that it regressed. Structural metadata only, never content; erased
-- with the relation (FK CASCADE), which is erased with its memories.

CREATE TABLE checked_pair (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  -- Canonical order (a < b), enforced so one conflict target covers the pair
  -- however the caller ordered it; `direction` is stored relative to this
  -- order and mapped back by the store.
  a_memory_id uuid NOT NULL REFERENCES memory (id) ON DELETE CASCADE,
  b_memory_id uuid NOT NULL REFERENCES memory (id) ON DELETE CASCADE,
  family text NOT NULL CHECK (family IN ('dedup', 'contradiction')),
  verdict text NOT NULL,
  direction text,
  -- Normalized [0,1] similarity at judgment time; NULL when the pair reached
  -- the check through the entity or subject path only.
  similarity real,
  -- 'deterministic:<rule>' when no model was asked (numeric/unit reasoning).
  prompt_version text NOT NULL,
  model_config text NOT NULL,
  config_version integer NOT NULL,
  judged_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT checked_pair_canonical_order CHECK (a_memory_id < b_memory_id)
);
CREATE UNIQUE INDEX checked_pair_pair_idx
  ON checked_pair (a_memory_id, b_memory_id, family);
CREATE INDEX checked_pair_b_idx ON checked_pair (b_memory_id);

CREATE TABLE entity_alias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  canonical text NOT NULL,
  alias text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX entity_alias_owner_pair_idx
  ON entity_alias (owner_id, lower(canonical), lower(alias));
CREATE INDEX entity_alias_owner_idx ON entity_alias (owner_id);

ALTER TABLE memory_relation ADD COLUMN detected_by text
  CHECK (detected_by IN ('pipeline', 'dreaming', 'repair'));

ALTER TYPE memory_relation_resolution ADD VALUE IF NOT EXISTS 'revision';

CREATE TABLE memory_relation_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  relation_id uuid NOT NULL REFERENCES memory_relation (id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event IN (
    'detected', 'party_superseded', 'resolved_by_user', 'resolved_by_revision',
    'kept_open', 'reopened'
  )),
  -- Structural metadata only: ids, sides, pass names, resolution values.
  detail_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_relation_event_relation_idx
  ON memory_relation_event (relation_id, created_at);
