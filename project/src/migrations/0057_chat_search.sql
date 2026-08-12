-- 0057: full-text search over conversations (issue #530).
--
-- Finding a conversation had exactly one handle: the auto-generated title.
-- That is the weak half. `conversation.title` is NULL until the first exchange
-- completes, the auto-titler can fail into the dead-letter queue, and when it
-- does succeed it is two to six words chosen by a model. The threads hardest
-- to find are precisely the ones with no title, and what a user remembers is
-- what they SAID.
--
-- This is deliberately the SAME construction memory has carried since 0005,
-- not a new mechanism: the IMMUTABLE `cogeto_unaccent()` wrapper (declared
-- there, reused here), a STORED generated tsvector over the content, and a GIN
-- index on it. Search then uses `websearch_to_tsquery` + `ts_rank_cd`, exactly
-- like `MemoryStore.ftsSearch`, so conversation search behaves the way fact
-- search already does: accent-insensitive, word-based, ranked.
--
-- `simple` rather than a language configuration, for the same reason 0005
-- chose it: the corpus is multilingual per user (en/hr today), and a stemmer
-- pinned to one language would silently degrade the others.
--
-- Titles are NOT indexed. A user has at most a few hundred conversations, so
-- the title arm of the query builds its tsvector on the fly over a
-- keyed, owner-scoped read; an index there would cost storage to save nothing
-- measurable.
--
-- Cost: one tsvector per message, roughly the size of the text again. The
-- ADD COLUMN rewrites the table, which is why it is worth knowing that
-- `chat_message` is bounded in practice (active conversations cap at 100 per
-- user) rather than an append-only firehose.
--
-- Reversal: DROP INDEX chat_message_content_tsv_idx, then
-- ALTER TABLE chat_message DROP COLUMN content_tsv. Nothing reads the column
-- but the search query, and nothing writes it (it is generated).

ALTER TABLE chat_message
  ADD COLUMN content_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', cogeto_unaccent(coalesce(content, '')))
  ) STORED;

CREATE INDEX chat_message_content_tsv_idx
  ON chat_message USING gin (content_tsv);
