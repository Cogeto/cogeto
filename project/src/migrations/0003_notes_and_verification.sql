-- Migration 0003 — Notes capture + verification results.
-- Feature tables arrive with their features:
-- note — the notes connector's source rows (owned by connectors);
-- verification_result — the verifier's verdict per admitted memory (spec §2, owned
-- by ingestion). Every memory created by the pipeline has
-- exactly one; the verdict is what earns the status.

-- ── note: the first connector's source rows ( — Notes first) ─────────────
-- Provenance targets: memory rows with source_type = 'user_note' point here.

CREATE TABLE note (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   text NOT NULL,
  content    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX note_owner_created_idx ON note (owner_id, created_at DESC);

-- ── verification_result: the spec §2 verdict that earned the memory's status ─────

CREATE TYPE verification_verdict AS ENUM ('supported', 'partial', 'unsupported');

CREATE TABLE verification_result (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- FK for lifecycle consistency only: the deletion saga's hard delete cascades
  -- here. Code access to memory rows stays behind the MemoryStore interface.
  memory_id      uuid NOT NULL REFERENCES memory (id) ON DELETE CASCADE,
  verdict        verification_verdict NOT NULL,
  reason         text NOT NULL,
  prompt_version text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX verification_result_memory_idx ON verification_result (memory_id);
