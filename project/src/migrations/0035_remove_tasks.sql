-- Migration 0035 — remove the task subsystem (V2.0 item 3.1; decision 0060).
--
-- The task engine, its two tables, its endpoints, prompts, jobs and UI are
-- gone. What the concept was FOR survives and needs no schema of its own: the
-- open loops are the `commitment`/`open_loop` memories themselves, their due
-- dates are `memory.valid_until`, and "gone quiet" is ingestion's dormant_flag
-- (all pre-existing). No deployed instance exists, so this is a clean drop —
-- no shim, no compatibility view.
--
-- Ordering matters: `task_conclusion` rows are the durable provenance behind
-- `source_type = 'task_conclusion'` memories (decision 0037). Those memories
-- are erased THROUGH the deletion saga before this migration runs (receipts
-- issued, Qdrant points and objects removed, the integrity sweep satisfied) —
-- see decision 0060 and scripts/dev/erase-task-conclusions.mjs. Dropping the
-- table without that would strand provenance and trip the sweep's orphan arm
-- (decision 0024). The guard below refuses to drop while such memories remain,
-- so the ordering cannot be lost by accident.
--
-- Residue this migration deliberately does NOT remove, because Postgres cannot:
--   * source_type value 'task_conclusion' — enum values are not droppable.
--     Defunct but known: nothing writes it, the sweep and the source_type
--     switches treat it as a value with no reader rather than an error.
-- And residue it does not remove because it is harmless and independently
-- meaningful:
--   * memory.authored_by_user, email_message.authored_by_owner — structural
--     provenance metadata written at admission; the second is the inbound
--     routing fact from decision 0031.

DO $$
DECLARE
  stranded bigint;
BEGIN
  SELECT count(*) INTO stranded FROM memory WHERE source_type = 'task_conclusion';
  IF stranded > 0 THEN
    RAISE EXCEPTION
      'refusing to drop task_conclusion: % memories still carry task_conclusion provenance. '
      'Erase them through the deletion saga first (decision 0060).', stranded;
  END IF;
END $$;

DROP TABLE IF EXISTS task_conclusion;
DROP TABLE IF EXISTS task;

DROP TYPE IF EXISTS task_conclusion_type;
DROP TYPE IF EXISTS task_status;

-- The skill runtime's adoption proposals went with the thing they proposed
-- adoption INTO (decision 0059 ruling 4 → decision 0060); the skill definition
-- bumped to research_brief/v0002 accordingly. Historical runs keep their step
-- log; only the proposal payload column goes.
ALTER TABLE skill_run DROP COLUMN IF EXISTS proposed_actions;
