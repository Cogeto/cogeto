-- 0050: the recorded ambiguity decision (V2.3 item 6.3, spec §7.5).
--
-- Every grounded assistant answer stores which entity clusters were
-- considered, their relevance and fused scores, which branch was taken
-- (dominant, silent, fan_out), the config version and the embedding model.
-- This is how a puzzling answer is diagnosed from stored data rather than by
-- re-running with logging, and how a fan-out's follow-up turn resolves the
-- reply deterministically against the subjects that were offered.
--
-- Content-bearing (cluster subjects are entity names), with the same erasure
-- story as the answer it explains: the answer-redaction cascade
-- (chat-answer-cascade) nulls `ambiguity` in the same UPDATE that overwrites
-- `content`; conversation and message deletion remove the row wholesale,
-- receipts unchanged. Null means "not computed": user rows, non-grounded
-- replies, and rows older than the feature.

ALTER TABLE chat_message ADD COLUMN ambiguity jsonb;
