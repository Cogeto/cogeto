-- Migration 0001 — the contractual core (Addendum §A.6 as amended by decision 0003).
-- Enums and the memory, file_metadata, deletion_receipt, approval, audit_log tables.
-- Reviewable SQL by design: this schema is contractual (scope, provenance NOT NULL,
-- six lifecycle statuses + orthogonal sensitive flag, validity intervals).

-- ── Enums ─────────────────────────────────────────────────────────────────────

CREATE TYPE scope AS ENUM ('private', 'shared');

-- Six lifecycle values; `sensitive` is a boolean column, not a status (0003 ruling 3).
CREATE TYPE memory_status AS ENUM (
  'active', 'outdated', 'contradicted', 'uncertain', 'replaced', 'user_approved'
);

-- Provenance is NOT NULL, always: "the user told me directly" is provenance too (§A.6).
CREATE TYPE source_type AS ENUM ('user_note', 'chat', 'email', 'calendar_event', 'file');

CREATE TYPE receipt_status AS ENUM ('pending', 'confirmed');

CREATE TYPE approval_status AS ENUM (
  'draft', 'pending_approval', 'approved', 'rejected', 'expired', 'executed'
);

-- ── memory: one stored, extracted fact with full trust metadata ───────────────

CREATE TABLE memory (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id              text NOT NULL,
  scope                 scope NOT NULL,
  source_type           source_type NOT NULL,
  source_id             text NOT NULL,
  status                memory_status NOT NULL DEFAULT 'active',
  sensitive             boolean NOT NULL DEFAULT false,
  valid_from            timestamptz,
  valid_until           timestamptz,
  -- Supersession never destroys history: the replaced row points at its successor (§B.2).
  superseded_by         uuid REFERENCES memory (id),
  content               text,
  content_embedding_ref text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX memory_owner_scope_idx ON memory (owner_id, scope);
CREATE INDEX memory_status_idx ON memory (status);
CREATE INDEX memory_source_idx ON memory (source_type, source_id);

-- ── file_metadata: pointers to original bytes in object storage (§4.10) ──────

CREATE TABLE file_metadata (
  object_key  text PRIMARY KEY,
  owner_id    text NOT NULL,
  scope       scope NOT NULL,
  sensitive   boolean NOT NULL DEFAULT false,
  upload_date timestamptz NOT NULL DEFAULT now(),
  checksum    text,
  size_bytes  bigint
);

-- ── deletion_receipt: provable forgetting, hash-chained (§A.7, §B.1) ──────────

CREATE TABLE deletion_receipt (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type  source_type NOT NULL,
  source_id    text NOT NULL,
  counts_json  jsonb,
  status       receipt_status NOT NULL DEFAULT 'pending',
  prev_hash    text,
  hash         text,
  signed_at    timestamptz,
  confirmed_at timestamptz
);

-- ── approval: the server-side action state machine (§A.8) ─────────────────────

CREATE TABLE approval (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type  text NOT NULL,
  payload_json jsonb,
  status       approval_status NOT NULL DEFAULT 'draft',
  requested_by text,
  decided_by   text,
  decided_at   timestamptz,
  executed_at  timestamptz,
  expires_at   timestamptz
);

-- ── audit_log: append-only record of transitions, approvals, deletions ────────

CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor       text NOT NULL,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  detail_json jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Append-only is enforced in the database, not by convention: any UPDATE or
-- DELETE raises. Erasure obligations are handled by dedicated migrations if
-- ever legally required, never by application code.
CREATE FUNCTION audit_log_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;

CREATE TRIGGER audit_log_no_update_or_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_forbid_mutation();
