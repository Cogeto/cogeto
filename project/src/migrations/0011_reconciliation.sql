-- Migration 0011 — reconciliation (Session F2-A; decision 0010).
--
-- memory.kind: the extractor has always produced a fact kind; reconciliation's
-- candidate rules need it on the row (kind match for dedup, kind gate for
-- contradiction). Nullable — pre-F2 rows have no kind and are conservatively
-- excluded from the kind-gated candidate paths.
--
-- memory_relation: pairs of memories reconciliation flagged, starting with
-- 'contradicts'. Prior statuses are recorded at detection so a dismissal can
-- restore both parties. A relation row — resolved or not — is a permanent
-- tombstone: the pair is never re-detected (dismissed stays dismissed).
-- Supersession stays on memory.superseded_by; this table is not overloaded.

CREATE TYPE fact_kind AS ENUM (
  'commitment',
  'decision',
  'preference',
  'fact',
  'open_loop'
);

ALTER TABLE memory ADD COLUMN kind fact_kind;

CREATE TYPE memory_relation_kind AS ENUM ('contradicts');

CREATE TYPE memory_relation_resolution AS ENUM (
  'confirmed_a',
  'confirmed_b',
  'corrected',
  'dismissed'
);

CREATE TABLE memory_relation (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           memory_relation_kind NOT NULL,
  -- a = the incoming (newer) fact at detection time, b = the existing one.
  a_memory_id    uuid NOT NULL REFERENCES memory (id) ON DELETE CASCADE,
  b_memory_id    uuid NOT NULL REFERENCES memory (id) ON DELETE CASCADE,
  a_prior_status memory_status NOT NULL,
  b_prior_status memory_status NOT NULL,
  detected_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  resolution     memory_relation_resolution,
  CONSTRAINT memory_relation_distinct_pair CHECK (a_memory_id <> b_memory_id),
  -- A resolution and its timestamp arrive together, or not at all.
  CONSTRAINT memory_relation_resolution_complete
    CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);

-- The canonical-pair tombstone: one relation per unordered pair per kind, ever.
CREATE UNIQUE INDEX memory_relation_pair_idx
  ON memory_relation (kind, least(a_memory_id, b_memory_id), greatest(a_memory_id, b_memory_id));

-- The Review queue reads open relations; both parties resolve by memory id.
CREATE INDEX memory_relation_open_idx ON memory_relation (detected_at) WHERE resolved_at IS NULL;
CREATE INDEX memory_relation_a_idx ON memory_relation (a_memory_id);
CREATE INDEX memory_relation_b_idx ON memory_relation (b_memory_id);
