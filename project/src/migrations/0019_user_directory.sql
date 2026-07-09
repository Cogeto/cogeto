-- Migration 0019 — the user directory (Session O2-B). The identity seam is
-- otherwise stateless (Principals derive from token claims), but shared scope
-- needs to name the OWNER of a memory another org member can see. Zitadel is not
-- queried per-owner (no management token on the read path); instead we record
-- each Principal the instant it authenticates ("provision on first login") and
-- resolve owner names from this local directory. One row per user; the display
-- name is refreshed on each fresh token resolve.
--
-- Identity-owned and module-private (the memories/chat surfaces read names only
-- through the identity seam's public interface, never this table).

CREATE TABLE app_user (
  user_id       text PRIMARY KEY,
  org_id        text NOT NULL,
  display_name  text NOT NULL,
  email         text,
  first_seen    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX app_user_org_idx ON app_user (org_id);
