# Task conclusions become memories (Priority 1a)

**Decision 0037 · migration 0025 · issue #167.**

When the task engine closes a task (closure detection or the user's manual
complete) or satisfies its waiting condition (`blocked_on_condition → open`),
it now derives one fact recording the event — "The revised proposal was sent
to Marko — on 14 July 2026 this completed the commitment … recorded on
2 July 2026." — so retrieval, dreaming, and future answers know about
completions, not just open items.

How it works, in one pass:

- The engine inserts a durable `task_conclusion` row (statement + the chain:
  task, deriving memory, trigger memory) and enqueues the **normal ingestion
  pipeline** on it, in the same transaction as the task transition. Provenance
  is the new `source_type 'task_conclusion'`. Tasks still never mutates a
  memory — `tasks_read_only_memory` is untouched.
- Phrasing is **deterministic** (no model call, no new prompt); quoted source
  text keeps its language.
- Scope follows the task; the conclusion is sensitive if any source in the
  chain is. One conclusion per (task, type, trigger) — reopened-then-reclosed
  tasks record a new conclusion, the old one stays as history.
- Conclusion memories reconcile like any fact (a completion can supersede the
  open commitment it fulfilled) but **never derive tasks** — the loop guard.
- UI: a concluded task links "produced this fact"; the memory's source drawer
  shows the statement and chain. Source deletion runs the standard saga.

Tests: `conclusion_on_closure`, `conclusion_on_condition_met`,
`conclusion_idempotent`, `conclusion_scope_sensitive`,
`conclusion_is_pipeline_not_raw`, `conclusion_participates` in
`project/src/tasks/task-conclusion.integration.spec.ts`.
