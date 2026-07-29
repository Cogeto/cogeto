-- Migration 0002 — async infrastructure (the specification spec §15.4) and the prompt registry (spec §12.3).
-- Kept out of 0001 so the contractual core stays exactly the set (0003 ruling 1).

-- Domain events written in the same transaction as the state change they describe.
-- The Graphile Worker job tables live in the graphile_worker schema (its own migrations).
CREATE TABLE outbox_event (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_event_type_idx ON outbox_event (event_type, created_at);

-- At-most-once effect ledger: the idempotency key of spec §15.4.
CREATE TABLE job_execution (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type  text NOT NULL,
  source_id    text NOT NULL,
  job_type     text NOT NULL,
  executed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, job_type)
);

-- Jobs that exhausted their retries; surfaced in the dashboard (spec §15.4).
CREATE TABLE dead_letter (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type  text NOT NULL,
  payload   jsonb,
  error     text NOT NULL,
  attempts  integer NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now()
);

-- Versioned prompt artifacts and their identity (spec §12.3); eval scores attach later (spec §14).
CREATE TABLE prompt_registry (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family       text NOT NULL,
  version      text NOT NULL,
  content_hash text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family, version)
);
