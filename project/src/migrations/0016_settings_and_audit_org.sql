-- Migration 0016 — user settings + org-scoped audit reads.
--
-- user_settings: the two real, wired per-user defaults exposes (
-- extract-and-discard default; the default scope for new captures/uploads).
-- One row per user, created on first write (read falls back to the defaults).
CREATE TABLE user_settings (
  user_id            text PRIMARY KEY,
  org_id             text NOT NULL,
  discard_by_default boolean NOT NULL DEFAULT false,
  default_scope      scope NOT NULL DEFAULT 'private',
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- audit_log.org_id: the audit trail becomes readable in, so it must be
-- org-scoped (spec §4.2). Additive + nullable — the append-only freeze trigger
-- (migration 0001) is untouched; existing rows keep NULL (system/global,
-- visible to any admin in the single-tenant instance). writeAudit populates it
-- for user-driven transitions.
ALTER TABLE audit_log ADD COLUMN org_id text;
CREATE INDEX audit_log_org_created_idx ON audit_log (org_id, created_at DESC);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
