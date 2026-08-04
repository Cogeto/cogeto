-- 0044: the displayed thinking channel (reasoning support Part C).
--
-- A reasoning model returns its deliberation in a separate stream beside the
-- answer. Cogeto displays it, live and afterwards, because hiding what the
-- instance's own model said while deciding would be the opposite of the
-- product's posture; but it is a CHANNEL, never content. The three honesty
-- rules are structural elsewhere: capture reads user rows only, citations and
-- the answer sanitizer read `content` only, and the eval harness never sees
-- the column.
--
-- Content-bearing, with the same erasure story as the answer it explains: the
-- answer-redaction cascade (chat-answer-cascade) nulls `thinking` in the same
-- UPDATE that overwrites `content`, because reasoning ABOUT an erased memory
-- must not survive the citation that grounded it; conversation and message
-- deletion remove the row wholesale, receipts unchanged.

ALTER TABLE chat_message ADD COLUMN thinking text;
