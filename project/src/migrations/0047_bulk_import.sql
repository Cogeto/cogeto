-- 0047: bulk import + document revision linking (V2.2 item 5.3).
--
-- import_run / import_item (owned by the new `imports` context): an import
-- is a first-class record -- its manifest, options, counts, state and
-- per-file outcomes. Items carry filenames and failure reasons, which makes
-- them content-adjacent: the deletion cascade TOMBSTONES an ingested item
-- when its source is erased (name cleared, outcome kept as arithmetic), so
-- the record's counts stay honest while no orphaned filename survives a
-- provable deletion. S3 credentials are NEVER stored: selected objects are
-- copied into the staging area at confirm time and the credentials are
-- discarded with the request.
--
-- source_revision (owned by ingestion, the decision record in
-- docs/features/revisions.md): the explicit supersedes-source relationship a
-- bulk re-import detects, with the measured basis and confidence, so the
-- decision is inspectable and reversible. Statuses: auto (the document's own
-- revision field said so), proposed (corroborated but awaiting the owner),
-- confirmed, rejected (remembered; the pair is never re-proposed), manual.
-- Rows leave with either source through the deletion cascade.

CREATE TABLE import_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  -- The owner's org: the coordinator mints final object keys with it.
  org_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('zip', 'folder', 's3')),
  state text NOT NULL DEFAULT 'manifest'
    CHECK (state IN ('manifest', 'running', 'completed', 'cancelled', 'failed')),
  -- Non-secret options only (source label, prefix, exclusions applied).
  options_json jsonb,
  -- The completion summary's real numbers, written once at finalize.
  counts_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX import_run_owner_created_idx ON import_run (owner_id, created_at);

CREATE TABLE import_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES import_run(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  -- The file's name (relative path inside the folder/ZIP/prefix). Cleared to
  -- NULL when the ingested source is erased (tombstone).
  name text,
  size_bytes bigint,
  content_type text,
  content_hash text,
  state text NOT NULL DEFAULT 'listed'
    CHECK (state IN ('listed', 'excluded', 'unsupported', 'duplicate',
                     'queued', 'ingested', 'failed', 'cancelled', 'tombstoned')),
  -- The staging twin holding the bytes between confirm and ingestion.
  staging_key text,
  -- The final source key once ingested (the file source's id).
  object_key text,
  -- The reason code for unsupported/failed items; never content.
  reason text,
  -- Same normalized filename as an existing source with a different hash:
  -- the revision-candidate nomination (docs/features/revisions.md).
  revision_of text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_item_run_idx ON import_item (run_id, state);
CREATE INDEX import_item_object_key_idx ON import_item (object_key);

CREATE TABLE source_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  successor_type text NOT NULL,
  successor_id text NOT NULL,
  predecessor_type text NOT NULL,
  predecessor_id text NOT NULL,
  status text NOT NULL
    CHECK (status IN ('auto', 'proposed', 'confirmed', 'rejected', 'manual')),
  -- Every measured signal behind the decision, inspectable and reversible.
  basis_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE UNIQUE INDEX source_revision_pair_idx
  ON source_revision (owner_id, successor_type, successor_id, predecessor_type, predecessor_id);
CREATE INDEX source_revision_predecessor_idx
  ON source_revision (predecessor_type, predecessor_id);
