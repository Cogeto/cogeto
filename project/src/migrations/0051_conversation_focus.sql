-- 0051: the conversation focus (issue #479, layer 3).
--
-- The subject a conversation is currently about, so a pronoun still binds after
-- a digression. Layer 1 passes the subject THIS turn resolved; this row carries
-- it forward when a later turn resolves none of its own.
--
-- Content-bearing: a subject entity is extracted content, so it lives inside the
-- conversation's own row and is erased with it by the existing cascade (the
-- conversation delete already removes the row). No new deletion arm is needed,
-- and none may be added: a focus that outlived its conversation would be a fact
-- about the user surviving a delete.
ALTER TABLE conversation
  ADD COLUMN IF NOT EXISTS focus_subject text,
  ADD COLUMN IF NOT EXISTS focus_set_at timestamptz;

COMMENT ON COLUMN conversation.focus_subject IS
  'Display subject the conversation is currently about (issue #479). Set only when a turn RESOLVED a subject; never inferred from scores. Content-bearing, erased with the conversation.';
COMMENT ON COLUMN conversation.focus_set_at IS
  'When the focus was last set. Drives the staleness rule: a focus older than the configured window stops being carried into new turns.';
