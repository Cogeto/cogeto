-- Migration 0015 — approval state machine goes live (O1-B, decision 0015).
-- The approval table + enum are contractual since migration 0001 (§A.8); this
-- session makes them live. Two additive, nullable/defaulted support columns the
-- machine needs — no enum change, no semantic change to the six states:
--   org_id     — tenant scoping for the confirm authorization (§A.4): only the
--                requesting org may see/decide an approval. Backfilled NULL on
--                the (empty) pre-O1-B table.
--   created_at — the "requested at" the Pending Approvals surface shows.
-- Plus a status index for the pending/history queries and the expiry sweep.

ALTER TABLE approval ADD COLUMN org_id text;
ALTER TABLE approval ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX approval_status_idx ON approval (status);
CREATE INDEX approval_org_status_idx ON approval (org_id, status);
