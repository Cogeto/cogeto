-- Migration 0005 — retrieval signals + chat persistence (S3-A; decision 0006).
-- (The S3-A prompt calls this "migration 0002"; 0002–0004 were taken by S1-B/S2.)
--
--   entities     — decision 0006 ruling 2: extracted entities as text[] on the
--                  memory row, GIN trigram index for the §A.5 entity signal.
--   content_tsv  — decision 0006 ruling 1: generated tsvector over content,
--                  simple config + unaccent (predictable across languages;
--                  Croatian has no built-in dictionary).
--   chat_message — the chat area's source rows (owned by retrieval): chat
--                  conversations persist, and future chat-derived memories get
--                  their §A.6 provenance target (source_type = 'chat').

CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- unaccent() is STABLE (dictionaries are mutable in principle), which disquali-
-- fies it from generated columns and expression indexes. This wrapper pins the
-- shipped dictionary and asserts immutability — the standard FTS pattern.
CREATE FUNCTION cogeto_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- array_to_string() is STABLE for the same formal reason; for text[] it is
-- immutable in fact. Pinned so the trigram index can be an expression index.
CREATE FUNCTION cogeto_entities_text(text[]) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT array_to_string($1, ' ') $$;

ALTER TABLE memory
  ADD COLUMN entities text[] NOT NULL DEFAULT '{}',
  ADD COLUMN content_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', cogeto_unaccent(coalesce(content, '')))
  ) STORED;

CREATE INDEX memory_entities_trgm_idx
  ON memory USING gin (cogeto_entities_text(entities) gin_trgm_ops);
CREATE INDEX memory_content_tsv_idx
  ON memory USING gin (content_tsv);

-- Backfill note: extraction output is transient by design (chunks and candidate
-- facts are never stored — AGENTS.md "Content"; verification_result keeps only
-- verdict + reason), so there is nothing to backfill entities from. Existing
-- rows keep '{}' and simply miss the entity signal until they are re-ingested;
-- FTS and vector search still cover them.

CREATE TYPE chat_role AS ENUM ('user', 'assistant');

CREATE TABLE chat_message (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   text NOT NULL,
  role       chat_role NOT NULL,
  content    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX chat_message_owner_created_idx ON chat_message (owner_id, created_at);
