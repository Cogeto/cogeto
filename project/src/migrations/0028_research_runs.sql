-- Migration 0028 — research runs: the show-edit-approve gate's durable record
-- (Priority 5 Part B; decisions 0044/0045).
--
-- A research run is the auditable trail of ONE research invocation: the user's
-- intent, the proposed query, the minimised query with its reason, and — only
-- after explicit user approval — the EXACT query text that left the instance
-- (`sent_query`, post-edit). Discovery runs solely from an 'approved' row, so
-- "you see precisely what leaves, and you approve it" is enforced by the
-- schema, not the UI. Captured pages link back via web_page.research_run_id,
-- giving every research-derived memory a provenance chain to the sent query:
-- memory → web_page → research_run.sent_query.

CREATE TYPE research_run_status AS ENUM ('proposed', 'approved', 'cancelled');

CREATE TABLE research_run (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         text NOT NULL,
  -- What the user asked for, verbatim (chat message or search box input).
  intent           text NOT NULL,
  -- The query the system formed from the intent (pre-minimisation).
  proposed_query   text NOT NULL,
  -- The least-identifying rewrite + the one-line reason for what was
  -- removed or kept (prompt family research_query_minimise).
  minimised_query  text NOT NULL,
  minimise_reason  text NOT NULL,
  -- The exact text that was sent to discovery — NULL until approved; set
  -- from the user's (possibly edited) approval, never from the proposal.
  sent_query       text,
  status           research_run_status NOT NULL DEFAULT 'proposed',
  -- The synthesised, citation-marked answer (Issue C); NULL until produced.
  answer           text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  approved_at      timestamptz,
  cancelled_at     timestamptz
);

CREATE INDEX research_run_owner_created_idx ON research_run (owner_id, created_at);

-- Captured pages remember which run fetched them (SET NULL keeps the page's
-- own provenance intact if a run record is ever removed).
ALTER TABLE web_page
  ADD COLUMN research_run_id uuid REFERENCES research_run (id) ON DELETE SET NULL;

CREATE INDEX web_page_research_run_idx ON web_page (research_run_id);
