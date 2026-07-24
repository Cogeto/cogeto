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

-- One-shot cleanup chain (decision 0054 ruling 5), via the migration-enqueue
-- pattern of 0014: first the email-authorship backfill (connectors classifies
-- historical email_message rows and stamps their memories), which then enqueues
-- the tasks derivation cleanup (the engine removes phantom tasks with an audit
-- entry per removal). Guarded — on a fresh clone the graphile schema does not
-- exist yet, and there is nothing to classify or clean there anyway.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'graphile_worker') THEN
    PERFORM graphile_worker.add_job(
      'email_authorship_backfill',
      json_build_object('source_type', 'email_authorship_backfill', 'source_id', 'migration-0030')::json
    );
  END IF;
END $$;
