# 0037 — Task conclusions become memories

**Date:** 2026-07-21 · **Status:** accepted · **Governs:** the derivation of a
memory when a task concludes (Post-v1 Backlog Priority 1a): the provenance
source type, the sanctioned path through the pipeline, scope/sensitivity
inheritance, idempotency and reopen semantics, phrasing, and the interaction
with reconciliation and derivation. **Driven by:** decision 0013 (task
engine), 0010 (reconciliation), 0021 (chat capture — the source-port
pattern), 0024 (provenance integrity), and the Priority-1 owner prompt.
Migration this session is **0025**.

Today the engine records condition satisfaction and closure only as task-table
state (`condition_met`, `closed_by_memory_id`, `status`). This freezes how
that conclusion becomes a fact, so retrieval, dreaming, and future answers
know about completions, not just open items.

## Ruling 1 — One memory per concluded event, via the normal pipeline

When the engine sets `condition_met` (`blocked_on_condition → open`) or
closes a task (`→ done`, whether by closure detection or the user's manual
complete), it derives **one** memory recording the event — a concise factual
statement ("The revised proposal was sent to Marko — on 14 July 2026 this
completed the commitment …"). The memory enters through the **normal pipeline
admission** (extract → verify → embed + store → reconcile) and is expected to
carry kind `fact`; it is verified, embedded, and reconciled like any other
fact. Dismissal is NOT a conclusion — a dismissed obligation produced no
event worth remembering.

## Ruling 2 — Provenance: source_type `task_conclusion`, a durable source row

`source_type` gains the value **`task_conclusion`**. Its durable source row is
the tasks-owned `task_conclusion` table (migration 0025): `id · owner_id ·
scope · sensitive · task_id · conclusion_type ('closed' | 'condition_met') ·
statement · deriving_memory_id · trigger_memory_id · created_at`. The derived
memory's NOT-NULL provenance (§A.6) points at this row, and the row carries
the **inspectable chain**: the task, the task's deriving memory, and the
memory whose admission triggered the conclusion (`trigger_memory_id` is NULL
when the user completed the task — no memory drove it). FKs to task and
memory are **ON DELETE SET NULL, never CASCADE**: the row is provenance and
must outlive what it references (decision 0024's "no orphans" bar); the
statement text is self-contained. The row joins the standard source-port
family — `TaskConclusionSourceReader` (stage-1 + the 0024 admission
checkpoint) and `TaskConclusionSourceDeletion` (the saga's port, which also
lets the integrity sweep's orphan arm probe the type), mirroring the chat
source ports.

## Ruling 3 — The ONE sanctioned path; the read-only boundary stands

This is the one path by which the tasks module causes a memory to exist, and
it is a **request, not a write**: inside the same transaction as the task
transition the engine inserts the conclusion row and enqueues
`ingestion.pipeline` on it through the outbox (§A.3). Tasks never inserts,
transitions, supersedes, or edits a memory row — the `tasks_read_only_memory`
test keeps forbidding every MemoryStore mutator, unchanged. What the boundary
means precisely: tasks may cause a NEW memory to exist by submitting a source
through the pipeline (where verification decides its status), and may never
mutate any EXISTING memory.

## Ruling 4 — Scope, sensitivity, phrasing

- **Scope** — the conclusion inherits the task's scope (which follows the
  deriving memory's chain head).
- **Sensitive** — the conclusion is sensitive if ANY source in its chain is:
  the deriving memory or the triggering memory. Frozen.
- **Phrasing is deterministic** — composed from task fields and the trigger
  fact (`buildConclusionStatement`), NO model call: the conclusion path can
  never be gated, garbled, or delayed by a model, and needs no versioned
  prompt or golden cases of its own. Quoted source text keeps its original
  language; the connective phrasing is English in v1. Dates are fixed-locale
  (en-GB, UTC) so re-derivation is byte-identical. A conclusion-phrasing
  prompt was considered and rejected: the model would add cost, latency, and
  eval surface to a sentence whose facts are already known exactly.

## Ruling 5 — Idempotency and reopen semantics

A task concludes once per event: the engine emits only on a real transition
(re-checked under row locks; user ops no-op idempotently), and the UNIQUE
index on `(task_id, conclusion_type, trigger_memory_id)` is the belt
underneath — re-delivery inserts nothing and enqueues nothing (the pipeline
job's §A.3 idempotency key guards the outer layer). A task the user
**reopened and that concludes again** records a **new** conclusion row and
memory (a new trigger, or a fresh user close with its own date); the earlier
conclusion memory is **left as history** — the engine cannot supersede it
(ruling 3), and whether the two conclusions merge or supersede is
reconciliation's call like any other pair of facts. NULL-trigger uniqueness
is deliberately not enforced so a reopened, re-completed task can conclude
again; those paths are transition-guarded instead.

## Ruling 6 — Reconciliation participates; derivation never does

Conclusion memories are ordinary facts: they retrieve, dedup, contradict,
and supersede under the existing 0010 rules — in particular a completion
fact can resolve (supersede) the open commitment it fulfilled when the
contradiction judgment and direction guard agree. The loop is closed
structurally: **a memory whose `source_type` is `task_conclusion` never
derives a task**, whatever kind the extractor assigned (`derivable()` checks
the source type). Conclude → derive → conclude cannot cycle; a conclusion MAY
still close or unblock OTHER tasks through the normal judgment path, which
terminates because each task concludes at most once per trigger.

## UI

The task links its conclusions (`GET /api/tasks/:id/conclusions`, each
resolved to the admitted memory) — "this task produced this fact" — and a
conclusion memory's source drawer renders the statement plus the chain
(`GET /api/tasks/conclusions/:id`). Deleting the conclusion memory's source
runs the standard saga through `TaskConclusionSourceDeletion`.
