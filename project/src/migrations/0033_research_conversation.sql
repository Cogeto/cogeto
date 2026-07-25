-- Migration 0033 — research answers land in the conversation (issue #259;
-- decision 0058, amending 0057 ruling 5).
--
--   conversation_id — the chat conversation a research run was invoked from
--                     (NULL for Research-page runs). When the run concludes,
--                     the answer is appended to this conversation as a
--                     persistent assistant message — automatically, no
--                     buttons. A value reference like memory provenance,
--                     deliberately no FK across module boundaries: if the
--                     conversation is deleted before conclusion, the append
--                     skips silently and the answer stays on the run.

ALTER TABLE research_run ADD COLUMN conversation_id uuid;
