-- 0058: a stopped answer says so (issue #532).
--
-- Chat gained a Stop button: an answer can be interrupted, and what was
-- written is KEPT rather than thrown away. A truncated reply that looks
-- exactly like a complete one reads as a bug, so the row carries the fact.
--
-- Boolean, not a status enum: there are two states, and inventing a lifecycle
-- for a thing with two states is how a column grows arms. `false` for every
-- existing row and every normal answer, so nothing about stored history
-- changes and no backfill is needed.
--
-- Deliberately NOT content-bearing: it says HOW the turn ended, never what was
-- said, so it is outside the answer-redaction cascade's content overwrite and
-- row deletion takes it implicitly.
--
-- Reversal: ALTER TABLE chat_message DROP COLUMN stopped.

ALTER TABLE chat_message ADD COLUMN stopped boolean NOT NULL DEFAULT false;
