# 0013 — Task-engine rulings (Session F3-B)

**Date:** 2026-07-05 · **Status:** accepted · **Governs:** the task model and
its single-writer engine, deterministic derivation, condition/closure
judgments, status semantics, the deletion cascade for derived tasks, and the
module wiring that keeps `tasks` read-only toward memory. **Driven by:**
glossary (*Task*, *Open loops*), scope §3 (the day-one job) / §4.7, the F2
dreaming handoff (dormant_flag contract), research agent-orchestration
(state-in-rows, idempotent at-least-once), and the F3-B owner prompt.
Migration this session is **0014**.

The module rule above all others here: **tasks reads memory through its
public interface and NEVER mutates it.** Closure and condition events are
observations recorded on task rows; no memory status moves because a task
did.

## Ruling 1 — The task model: one task per deriving memory, following the chain

`task` (tasks-owned, migration 0014): `id · owner_id · scope` (inherited from
the deriving memory) `· derived_from_memory_id NOT NULL UNIQUE` (FK memory ON
DELETE CASCADE — the safety net; the saga's port does the counted delete) `·
title · primary_person · entities[] · condition_text · condition_met bool ·
condition_met_by_memory_id · due` (from the memory's `valid_until`) `· status
enum(open, blocked_on_condition, done, dismissed) · closed_by_memory_id ·
dormant bool · from_uncertain bool · created_at/updated_at`.

**Supersession re-points, never duplicates:** when the deriving memory is
`replaced`, the engine moves `derived_from_memory_id` to the chain head and
refreshes the structural fields (title/condition/due) from the head. If the
head already carries its own task (two same-obligation tasks met through a
merge), the re-pointing task is **dismissed** with audit reason
`superseded_duplicate` — the obligation survives exactly once. The state
lives entirely in the row (research §1): every engine action is resumable
from the table alone.

## Ruling 2 — Derivation is deterministic; the model never decides WHETHER

Memories with `kind` `commitment` or `open_loop` derive a task **on
admission** — both `active` and `uncertain` (an uncertain-derived task is
marked `from_uncertain`; Review approval confirms it, Review rejection
deletes the memory and the FK takes the task). Field mapping is structural:
title from the memory content (a pipeline-tier model call MAY rephrase into
imperative form, and on any failure the raw content IS the title — the call
never gates derivation), `primary_person` = subject_entity ?? first person
entity, `condition_text` from the extractor's condition, `due` from
`valid_until`, status `blocked_on_condition` iff condition_text is present
and unmet, else `open`.

Invocation: the pipeline enqueues `tasks.derive` (payload = the source ref)
via the outbox in the same transaction as stage 6 — cross-module by event,
never by import (the constant lives in ingestion; `tasks` imports ingestion,
never the reverse). The dreaming cycle enqueues the idempotent backfill
nightly, and migration 0014 enqueues it ONCE for historical memories
(guarded: skipped on a fresh clone where the graphile schema does not exist
yet — there is nothing to backfill there anyway). Idempotency everywhere via
the UNIQUE deriving-memory constraint: re-derivation is a no-op.

## Ruling 3 — Condition and closure: model-confirmed, biased to no action

Candidate generation is deterministic and mirrors F2 (0010 ruling 6): for
each newly admitted fact, the owner's tasks in `open`/`blocked_on_condition`
sharing at least one entity (case-insensitive exact) or the primary person.
Model confirmation via two new pipeline-tier families:

- `task_condition/v0001` — does this fact satisfy the task's stated waiting
  condition? `satisfied | not_satisfied | unrelated`. Satisfied sets
  `condition_met` (+ the causing memory id) and flips
  `blocked_on_condition → open`.
- `task_closure/v0001` — does this fact show the obligation was FULFILLED?
  `closes | progresses | unrelated`. Closes sets `done` +
  `closed_by_memory_id`. `progresses` deliberately changes NOTHING.

Both prompts state the cost table: **a wrongly closed task hides an
obligation** — worse than a stale open task; doubt resolves to no action.
Order per fact: closure first (a fulfilled task needs no unblocking), then
condition, one action per task per run, capped checks per fact. Every action
audited (`task.*` actions); everything idempotent under re-delivery (state
re-checked under row locks; settled tasks leave the candidate pool).

## Ruling 4 — Status semantics and the user's override

`blocked_on_condition` ⟺ condition_text present ∧ ¬condition_met; `open`
otherwise; `done` only via closure or the user's manual complete; `dismissed`
only via the user. User operations now (debug surface; O2 builds the real
UI): **reopen** (done/dismissed → open|blocked per the condition rule, clears
closure fields), **dismiss**, **complete** — all owner-checked, audited,
idempotent. The engine never un-does a user decision: user-set `done`/
`dismissed` tasks are out of every engine candidate pool, and `reopen` is the
user's, not the machine's.

## Ruling 5 — Dormancy is consumed, not duplicated

Per the F2 handoff: the engine reads open dormant flags through ingestion's
NEW public API (`listOpenDormantFlags`), sets `task.dormant = true` for tasks
whose chain contains a flagged memory, and — when a task closes or is
dismissed — clears the flag (`clearDormantFlag`), fulfilling the "F3 clears
on task closure" half of the contract. `dormant` is presentation state on the
task, never a status.

## Ruling 6 — Deletion cascade counts tasks (extends 0008 ruling 4 additively)

The memory module gains a `DERIVED_CASCADES` port (the third of the family:
SourceReader, SourceDeletion, now DerivedCascade): implementations delete
their rows derived from the doomed memory ids inside the enumeration
transaction and return counts. `tasks` implements it; composition roots bind
it. The receipt's `counts_json` gains OPTIONAL `tasks_removed` — additive, no
schema break, old receipts parse unchanged; the sweep ignores it (a count,
not an identifier). The FK CASCADE remains as the belt under the port's
suspenders.

## Ruling 7 — The open-loops answer

`query_rewrite/v0003` adds an `open_loops` intent (entity-scoped variant),
double-guarded exactly like temporal (0012 ruling 2): an en+hr hint lexicon
("still open / outstanding / waiting on / što je otvoreno / obećao…") both
enables and vetoes. Retrieval mode `tasks` lists the Principal's own
open+blocked tasks (due-dated first, dormant flagged), resolves their
deriving memories through the gated read (citations = deriving memories),
and `answer/v0004` renders the human list: blocked with their condition
("waiting on …"), dormant noted as quiet, done/dismissed never shown. Gates
unchanged — another user's tasks are unrepresentable in the query
(owner-scoped SQL + gated memory resolution).
