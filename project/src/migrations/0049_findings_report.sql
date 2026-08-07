-- 0049: the findings report (V2.3 item 6.2).
--
-- findings_report (owned by reports): the findings-run ledger. One row is one
-- run: who ran it, over which scope, when, under which model configuration,
-- the counts it produced, and pointers to the two rendered artifacts (JSON and
-- PDF) in object storage. The row is the record the delta view compares
-- against, so it OUTLIVES its artifacts: retention and the deletion cascade
-- null the object keys and flip status to 'expired', but never delete the row.
-- The artifacts are content-bearing (verbatim source spans); the row itself
-- carries only scope, counts and integrity metadata, never quoted content.
--
-- scope_key is the canonical serialization of scope_json (sorted keys,
-- compact), so "the previous run over the same scope" is one indexed lookup
-- rather than a jsonb comparison with undefined key order.
--
-- previous_report_id records which run the delta was computed against at
-- generation time; ON DELETE SET NULL because a report must survive its
-- predecessor's disappearance (rows are never deleted today, but the schema
-- must not make that impossible).
--
-- Reversal: dropping the table below reverses this migration; the artifacts
-- in object storage are swept by the retention pass keyed on it, so reverse
-- only after that pass runs dry.

CREATE TABLE findings_report (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  org_id text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'ready', 'failed', 'expired')),
  report_version text NOT NULL,
  locale text NOT NULL DEFAULT 'en',
  scope_json jsonb NOT NULL,
  scope_key text NOT NULL,
  model_config_id text,
  previous_report_id uuid REFERENCES findings_report(id) ON DELETE SET NULL,
  counts_json jsonb,
  progress_json jsonb,
  json_object_key text,
  pdf_object_key text,
  json_size_bytes bigint,
  pdf_size_bytes bigint,
  payload_sha256 text,
  signature text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  expires_at timestamptz
);

CREATE INDEX findings_report_user_idx ON findings_report (user_id, created_at DESC);
CREATE INDEX findings_report_retention_idx ON findings_report (status, expires_at);
CREATE INDEX findings_report_scope_idx ON findings_report (user_id, scope_key, created_at DESC);
