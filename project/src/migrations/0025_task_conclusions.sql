-- Migration 0025 — the task loop's last piece (decision 0037, decision 0038).
--
-- 1a. Task conclusions become memories: a new provenance source_type
--     'task_conclusion' and its durable source row. When the engine closes a
--     task or satisfies its condition (or the user completes it), it records
--     ONE conclusion row here and enqueues the normal ingestion pipeline on
--     it — the derived memory's §A.6 provenance points at this row, and the
--     row carries the inspectable chain (task, deriving memory, trigger).
--     The FKs are SET NULL, never CASCADE: this row is provenance and must
--     outlive the task/memory rows it references (no orphaned memories —
--     decision 0024's bar). The statement text is self-contained.
--
-- 1b. Create-a-task-from-chat: the chat message gains a nullable
--     capture_content — the normalized commitment text the pipeline extracts
--     from when a create_task intent captured the message (the raw message
--     stays untouched as the provenance target; capture_content is the
--     transient-extraction-input made durable, decision 0038).

ALTER TYPE source_type ADD VALUE IF NOT EXISTS 'task_conclusion';

CREATE TYPE task_conclusion_type AS ENUM ('closed', 'condition_met');

CREATE TABLE task_conclusion (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id             text NOT NULL,
  scope                scope NOT NULL,
  sensitive            boolean NOT NULL DEFAULT false,
  task_id              uuid REFERENCES task (id) ON DELETE SET NULL,
  conclusion_type      task_conclusion_type NOT NULL,
  -- The deterministic, self-contained conclusion statement (decision 0037
  -- ruling 4) — the pipeline's extraction input and the drawer's context.
  statement            text NOT NULL,
  -- The inspectable chain: the task's deriving memory and the memory whose
  -- admission triggered the conclusion (NULL for a user-completed task —
  -- no memory drove it — and after a referenced memory is erased).
  deriving_memory_id   uuid REFERENCES memory (id) ON DELETE SET NULL,
  trigger_memory_id    uuid REFERENCES memory (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Idempotency belt (decision 0037 ruling 5): one conclusion per
-- (task, type, trigger). NULL triggers (user complete) stay distinct so a
-- reopened task completed again by the user records a NEW conclusion; those
-- paths are transition-guarded in the engine instead.
CREATE UNIQUE INDEX task_conclusion_once_idx
  ON task_conclusion (task_id, conclusion_type, trigger_memory_id);

CREATE INDEX task_conclusion_task_idx ON task_conclusion (task_id);
CREATE INDEX task_conclusion_owner_idx ON task_conclusion (owner_id);

ALTER TABLE chat_message ADD COLUMN capture_content text;
