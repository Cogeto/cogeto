-- Migration 0032 — research concludes server-side + focused web extraction
--.
--
-- 'concluded' — the research_run gate gains a terminal success state:
-- when the last captured page's extraction settles, a
-- worker job synthesises and STORES the answer on the run,
-- so leaving the chat mid-research no longer loses the
-- response. concluded_at stamps it; answer_seen_at records
-- that the owner saw the stored answer (the chat resume
-- surface shows a run until then, never after).
-- extraction_text — the focused extraction view of a fetched page: at
-- capture time the page's chunks are ranked against the
-- run's sent query by EMBEDDINGS ONLY (no model calls) and
-- the most relevant ones are kept for the extractor.
-- retained_text stays complete — the source of record for
-- the drawer, synthesis excerpts and audits; NULL means
-- the page is small (or query-less) and extraction reads
-- retained_text as before.

ALTER TYPE research_run_status ADD VALUE IF NOT EXISTS 'concluded';

ALTER TABLE research_run
  ADD COLUMN concluded_at timestamptz,
  ADD COLUMN answer_seen_at timestamptz;

ALTER TABLE web_page ADD COLUMN extraction_text text;
