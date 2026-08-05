-- 0045: chat attachments + pipeline progress (V2.2 item 5.1, chat-centric
-- capture).
--
-- Chat becomes the conversational door for files. Two tables:
--
-- chat_attachment (owned by chat): the conversation's record of one attached
-- file. Two modes, decided at attach time:
--
--   Durable (the default): the file goes through the NORMAL upload path and
--   becomes an ordinary file source (file_metadata, read report, facts,
--   provenance) -- this row is only the LINK between that source and the
--   conversation, plus the stamped outcome (fact and contradiction counts,
--   read outcome, gate refusal) once the pipeline settles, so the conversation
--   can keep showing the honest confirmation without re-querying forever.
--   When the file source is later deleted, the deletion cascade clears the
--   display name (the filename is erased with the bytes -- no orphaned
--   filename survives a provable deletion) and marks the row source_deleted.
--
--   Transient ("don't remember this file"): never a source. The bytes are
--   staged at the object key's staging twin (the discard-mode mechanism),
--   read ONCE by a chat-owned worker job through the same reading ladder, and
--   deleted; the extracted text lives HERE, scoped to this conversation, for
--   the answer path to draw on. Content-bearing, so the row is erased by the
--   conversation deletion saga inside the same enumeration transaction and
--   counted on the receipt (chat_attachments_removed). Staging keys never
--   enter provenance or receipts; staging_key is nulled once the bytes are
--   scheduled for deletion.
--
-- ingestion_progress (owned by ingestion): the honest per-source pipeline
-- stage (reading, extracting, verifying, storing), upserted OUTSIDE the job
-- transaction (the file_read_report precedent: a stage row that rolled back
-- with a failing job could not explain it). Metadata only -- source
-- identifiers and a stage name, never content. Terminal state still comes
-- from the queue's own ledgers; this row is what turns "processing" into a
-- stage a person can watch. Rows leave with their source through ingestion's
-- deletion cascade, like the gate refusal ledger.

CREATE TABLE chat_attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  -- The user message it was sent with; NULL for an attachment sent alone.
  message_id uuid,
  transient boolean NOT NULL,
  -- Durable: the file source's object key (also its source_id). NULL for
  -- transient attachments, which have no source.
  object_key text,
  -- Transient only: where the bytes are staged until the read job commits.
  staging_key text,
  display_name text,
  content_type text,
  size_bytes integer,
  -- Transient lifecycle: 'pending' -> 'ready' | 'failed'. Durable rows keep
  -- 'pending' until the status read stamps 'settled', and the file-source
  -- deletion cascade marks 'source_deleted'.
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'failed', 'settled', 'source_deleted')),
  -- Transient only: the text the reading layer produced, for THIS
  -- conversation's answer path. Content-bearing.
  content_text text,
  -- What the reading layer made of the bytes (both modes, stamped at settle).
  read_outcome text,
  read_reason text,
  -- Durable, stamped at settle: the honest confirmation's real numbers.
  facts_count integer,
  contradictions_count integer,
  -- Durable, stamped at settle when the extraction gate refused the source.
  gate_refusal text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);

CREATE INDEX chat_attachment_conversation_idx
  ON chat_attachment (conversation_id, created_at);
CREATE INDEX chat_attachment_object_key_idx
  ON chat_attachment (object_key);

CREATE TABLE ingestion_progress (
  source_type text NOT NULL,
  source_id text NOT NULL,
  stage text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_type, source_id)
);
