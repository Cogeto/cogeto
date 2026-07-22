-- Migration 0027 — web research core (Priority 5 Part A; decisions 0042/0043).
--
-- Fetched web pages become first-class sources: a new provenance source_type
-- 'web' and its durable source row. Discovery (self-hosted SearXNG) selects
-- URLs; the narrow fetcher retrieves and extracts readable text; that text is
-- RETAINED here as the complete source of record (retention decision 0043:
-- clean text + URL by default; the raw HTML object is optional), and the normal
-- ingestion pipeline extracts memories whose §A.6 provenance points at this row
-- — so a web fact is visibly a web fact, one click from its URL and fetch time.

ALTER TYPE source_type ADD VALUE IF NOT EXISTS 'web';

CREATE TABLE web_page (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          text NOT NULL,
  scope             scope NOT NULL DEFAULT 'private',
  sensitive         boolean NOT NULL DEFAULT false,
  -- The URL the user selected for capture (pre-redirect), and the final URL
  -- the content actually came from (post-redirect) — both retained so
  -- provenance is honest about what was asked for and what answered.
  requested_url     text NOT NULL,
  final_url         text NOT NULL,
  title             text,
  -- When the page was fetched — the temporal anchor ("as of") every derived
  -- memory's relative dates resolve against, and the answer to "when did
  -- Cogeto read this?".
  fetched_at        timestamptz NOT NULL,
  -- The extracted readable text (boilerplate stripped) — the retained source
  -- of record and the pipeline's extraction input (decision 0043).
  retained_text     text NOT NULL,
  -- Optional raw-HTML retention (COGETO_RESEARCH_RETAIN_HTML): the sanitised
  -- original in MinIO under the scoped key scheme; NULL when off (default).
  raw_object_key    text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX web_page_owner_fetched_idx ON web_page (owner_id, fetched_at);
