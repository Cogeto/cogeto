-- Migration 0031 — multiple conversations (P6.9).
--
-- conversation — the chat area's workspace container (owned by
-- retrieval, like chat_message): per-user threads the
-- sidebar lists, switches, renames, archives and
-- deletes. Memory is the continuity, conversations are
-- workspaces — knowledge crosses threads only through
-- memory retrieval, never through another thread's raw
-- turns. title is NULL until the auto-titler names the
-- thread (or the user does — title_set_by_user then
-- locks it against any auto overwrite). updated_at is
-- the last-message time, the sidebar's recency order.
-- conversation_id — every chat_message now lives in exactly one
-- conversation (NOT NULL + FK). Existing messages are
-- preserved: one "Earlier conversation" container per
-- user adopts the whole pre-0031 history, so no message
-- is orphaned and every chat-derived memory's
-- provenance (source_type 'chat' → chat_message.id)
-- keeps resolving unchanged.
-- chat_conversation — new source_type enum value: deleting a conversation
-- is a source deletion through the spec §11.1 saga (one
-- receipt covering the thread's messages and every
-- memory derived from them). No memory row ever carries
-- it — memories keep citing the message ('chat'); the
-- value exists for the receipt and the saga adapter.

CREATE TABLE conversation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          text NOT NULL,
  title             text,
  title_set_by_user boolean NOT NULL DEFAULT false,
  archived          boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX conversation_owner_updated_idx ON conversation (owner_id, updated_at DESC);

ALTER TABLE chat_message ADD COLUMN conversation_id uuid;

-- The legacy container: one per user with any history, titled plainly and
-- timestamped from the history it adopts. title_set_by_user stays false, but
-- the auto-titler only ever names an untitled (NULL) conversation, so this
-- title is stable too.
INSERT INTO conversation (owner_id, title, created_at, updated_at)
SELECT owner_id, 'Earlier conversation', min(created_at), max(created_at)
FROM chat_message
GROUP BY owner_id;

UPDATE chat_message m
SET conversation_id = c.id
FROM conversation c
WHERE c.owner_id = m.owner_id;

ALTER TABLE chat_message
  ALTER COLUMN conversation_id SET NOT NULL,
  ADD CONSTRAINT chat_message_conversation_fk
    FOREIGN KEY (conversation_id) REFERENCES conversation(id);

CREATE INDEX chat_message_conversation_created_idx
  ON chat_message (conversation_id, created_at);

-- Deleting a conversation goes through the deletion saga like any source; the
-- enum value types its receipts. Memories never carry it (they cite the
-- message), so no backfill exists for it by construction.
ALTER TYPE source_type ADD VALUE IF NOT EXISTS 'chat_conversation';
