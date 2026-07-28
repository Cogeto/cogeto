-- Migration 0030 — task-derivation discipline (P6.5; decision 0054).
-- Tasks derive ONLY from first-person sources: notes, chat, and the new
-- content of email the user wrote or sent. Three additive columns:
--
--   memory.authored_by_user     — email-path authorship, set at admission by
--                                 the pipeline from structural message metadata
--                                 (self-routed sender + no forwarded original).
--                                 NULL = unknown (pre-0030 rows until the
--                                 backfill classifies them) — and unknown never
--                                 derives (conservative bias).
--   email_message.authored_by_owner — the intake-time routing fact (decision
--                                 0031 rule 1: SPF-authenticated self-route).
--                                 NULL = pre-0030 row, classified by the
--                                 backfill job from from_addr.
--   task.adopted                — the user adopted this task from an observed
--                                 memory ("Make this a task"): the first-person
--                                 act that satisfies the derivation rule. The
--                                 cleanup never touches adopted tasks.

ALTER TABLE memory ADD COLUMN authored_by_user boolean;
ALTER TABLE email_message ADD COLUMN authored_by_owner boolean;
ALTER TABLE task ADD COLUMN adopted boolean NOT NULL DEFAULT false;

-- NEUTRALIZED in 2.0 (decision 0060). This migration once enqueued the
-- one-shot `email_authorship_backfill` job, which chained to the tasks
-- derivation cleanup (decision 0054 ruling 5). Both job types went with the
-- task subsystem; leaving the enqueue would park a permanently failing job on
-- every fresh database, since migrations replay from 0001. The columns above
-- are untouched and still added exactly as before — `memory.authored_by_user`
-- and `email_message.authored_by_owner` remain as structural provenance
-- metadata, written at admission by the pipeline.
