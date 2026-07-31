-- 0038: durable abuse limits (security audit 2.0, SEC-18 / SEC-10 / SEC-27).
--
-- Every abuse limit used to live in an in-process Map: the daily model budget,
-- the ingest/research quotas and the per-principal rate-limit windows. A
-- restart cleared all of them, so an app under `restart: unless-stopped` that
-- crash-looped REMOVED the only ceiling on model spend; and the app and the
-- worker each counted their own half of the truth.
--
-- Both tables follow the job_execution pattern: a small, content-free,
-- unique-keyed row that any process can upsert atomically, so the limit is one
-- shared number rather than one per process.
--
-- usage_counter — per user, per bucket, per period, per task family.
--   * bucket is the metered resource: model_calls, model_tokens, capture,
--     upload, research_search, research_page.
--   * period is the UTC calendar day ('YYYY-MM-DD'); the day rolls over by
--     writing a new key, so no reset job exists and history is retained.
--   * task_family is the work that caused the spend ('chat', 'ingestion',
--     'dreaming', …) or '' when the caller does not attribute one. It is part
--     of the primary key so the planned token-accounting feature can report
--     per user / per period / per task family off this table with no further
--     migration. Every limit check SUMs across families, so adding a family
--     never changes an enforced total.
--   No memory content, no prompt text, no token values: counts only.
--
-- rate_limit_window — the fixed-window request limiter's state, one row per
--   (principal, bucket). window_start is the start of the current window; the
--   upsert resets the count when the stored window has expired, which makes
--   "check and increment" a single atomic statement shared by every process.
--   Expired rows are pruned opportunistically by the store (SEC-27), which is
--   the durable counterpart of the identity cache's eviction pass.

CREATE TABLE usage_counter (
  user_id     text   NOT NULL,
  bucket      text   NOT NULL,
  period      text   NOT NULL,
  task_family text   NOT NULL DEFAULT '',
  count       bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bucket, period, task_family)
);

-- Reporting/retention access path: everything for one period.
CREATE INDEX usage_counter_period_idx ON usage_counter (period, user_id);

CREATE TABLE rate_limit_window (
  principal_id text NOT NULL,
  bucket       text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (principal_id, bucket)
);

-- The eviction pass reads by age.
CREATE INDEX rate_limit_window_start_idx ON rate_limit_window (window_start);
