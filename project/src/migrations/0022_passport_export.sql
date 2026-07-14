-- Migration 0022 — the Memory Passport export ledger (§B.5, decision 0029).
-- A user triggers an export from Settings; a worker job assembles the signed,
-- documented archive and stores it as a short-lived, owner-scoped object. This
-- table is the request/status record the SPA polls and the download endpoint
-- authorizes against — one row per export request, owner-scoped by user_id.
--
-- Passport-module-owned and module-private (no other module reads this table).
-- The artifact itself lives in object storage, not here; `object_key` points at
-- it and is null until the job succeeds.

CREATE TABLE passport_export (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           text NOT NULL,
  org_id            text,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'ready', 'failed', 'expired')),
  passport_version  text NOT NULL,
  include_originals boolean NOT NULL DEFAULT false,
  object_key        text,
  size_bytes        bigint,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  ready_at          timestamptz,
  -- Short-lived: the retention job deletes the object and marks the row expired
  -- after this instant. Set when the export becomes ready.
  expires_at        timestamptz
);

CREATE INDEX passport_export_user_idx ON passport_export (user_id, created_at DESC);
CREATE INDEX passport_export_retention_idx ON passport_export (status, expires_at);
