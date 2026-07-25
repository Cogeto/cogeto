# 0059 — Named skills: a visible, resumable, governed skill runtime

**Date:** 2026-07-25 · **Status:** accepted · **Governs:** the skill model
(registry, `skill_run`, the step log), the plan-level research gate, the
research-brief skill (`skills/research_brief/v0001`), its surface, evals and
demo (issues #261/#262/#263 — Post-v1 Priority 7, Release D). **Driven by:**
the backlog's Release D claim ("agents whose every step is inspectable, every
fact sourced, and every consequential action waits for you"), decisions
0044/0045 (the research gate), 0054 (task-derivation discipline), 0057/0058
(server-side conclusion), and `docs/research/agent-orchestration-patterns.md`
(checkpoint rows + the job queue; refuse graph machinery). Migration this
session is **0034**; prompts this session are **skill_plan/v0001** and
**skill_brief/v0001**.

## Ruling 1 — A skill is a code-defined, versioned plan of typed steps

A skill is a named, versioned, multi-step workflow with a declared plan: an
ordered set of steps, each with a kind (`gather_from_memory`,
`propose_searches`, `gated_search`, `fetch_and_extract`, `verify`,
`synthesise`, `propose_actions`). Skills are code artifacts in a registry
(`connectors/skills/skill-registry.ts`, versioned like prompts:
`research_brief` / `v0001`), never user-programmable in v1. The registry entry
IS the contract: the run's step log is created from it, so a finished run is
always readable against the plan that produced it.

The runtime lives in **connectors**, beside the research machinery it
orchestrates (the `research_run` precedent) — `agents` cannot host it without
a cycle (connectors already imports the approval service for email drafts),
and governance still flows THROUGH agents' approval machine and the tasks
module's adoption endpoint, never around them.

## Ruling 2 — The run record and its step log are the inspectability claim

`skill_run` (migration 0034): id, skill id + version, owner, subject, status
(`planning`, `awaiting_approval`, `running`, `awaiting_input`, `completed`,
`failed`, `cancelled`), the brief + its citations, the proposed actions,
started/finished timestamps. `skill_run_step`: one row per plan step —
status (`pending`, `running`, `completed`, `failed`, `skipped`), an inputs
summary, an outputs summary, and `links` (research run ids, page ids, memory
ids, counts) so every artifact a step produced is one click away. Every status
transition is audit-logged structurally (`skill_run.proposed`,
`.plan_approved`, `.cancelled`, `.completed`, `.failed`) — never content.
The step row is the checkpoint (orchestration-patterns ruling: persisted rows
plus the job queue, no graph runtime).

## Ruling 3 — The research gate is preserved at plan granularity

A skill's query plan is **N ordinary `research_run` rows** (one per proposed
query, tagged `skill_run_id`), created in `proposed` and shown together at the
gate. The user approves the plan in ONE interaction — approve all, edit any,
remove any — and the approval endpoint flips each kept run to `approved` with
its (possibly edited) text as `sent_query`, cancelling removed ones. Nothing
new is carved through the 0045 invariant: discovery still runs only from an
approved `research_run`, the sent query is recorded immutably, provenance
(memory → web_page → research_run.sent_query) is byte-identical to manual
research, and audit rows land per run plus one `skill_run.plan_approved`.

Skill queries are GENERATED (subject + memory context), not user-typed, so
minimisation happens at generation: `skill_plan/v0001` (pipeline tier) is
instructed to produce the least-identifying queries that serve the intent, and
each run's `minimise_reason` says so. The gate remains the guarantee — the
user sees and edits exactly what would leave, before anything does. If the
planning model is unavailable, deterministic fallback queries (identity +
recent news) are proposed with an honest reason, mirroring the 0044 fail-open
rule: the failure mode is "review it yourself", never "silently sent".

## Ruling 4 — Skills never create tasks; consequential actions wait

The first-person rule (0054) holds untouched: skill-observed obligations
become ordinary memories (web sources never derive). The brief PROPOSES
actions — adoption proposals grounded in specific memories (kind
`commitment`/`open_loop`, not authored by the user), stored as
`proposed_actions` on the run in state `proposed`. Accepting one goes through
the EXISTING `POST /api/tasks/adopt` (audited `task.adopted`, idempotent);
the skill surface only records `accepted`/`dismissed` on the proposal. The
skills code has no path to the tasks module. Any future skill action that
writes outside the instance routes through the §A.8 approval machine — the
runtime adds no second executor.

## Ruling 5 — Execution is worker-side, resumable, budget-capped, cancellable

Planning (memory gather via entity-profile retrieval + the one `skill_plan`
call) runs in the propose request — the same fast-path shape as chat's
research propose — and ends at `awaiting_approval`. Everything after approval
is the worker's `skill.advance` job: a re-runnable task that claims the next
step, executes it, checkpoints, and re-enqueues itself. Search + capture reuse
`ResearchService` verbatim (budgets, SSRF guard, robots, focused extraction);
the settle-watcher (0057) branches for skill-owned runs — when ALL pages of
ALL of a skill run's research runs settle, it enqueues `skill.advance` instead
of `research.conclude`, so skill research runs stay `approved` and never store
per-run answers. Re-delivery is safe: searched queries are recorded in the
step's links and skipped, capture is guarded by existing pages, terminal
states are compare-and-set.

Budgets: the plan caps at `COGETO_SKILL_MAX_QUERIES` (6) queries and
`COGETO_SKILL_PAGES_PER_QUERY` (3) pages per query; the existing daily
research budgets apply unchanged inside `ResearchService`. Hitting a cap is
graceful: remaining work is skipped with an honest note in the step's outputs
and the run completes with what it has. Cancel stops cleanly at the next step
boundary and keeps everything already produced (pages, memories, partial log).

## Ruling 6 — The brief is durable, cited per claim, and speaks the anchor language

`skill_brief/v0001` (answer tier — the only skill stage on it) writes the
brief over `[M#]` (memory) and `[W#]` (page, URL + fetch time) markers with
model knowledge marked `(unsourced)`; unresolvable markers are stripped (the
0045 sanitize rule). The brief text + resolved citations persist on the run
row — renderable forever with live citation links, exportable as text — and
the web memories persist as ordinary sources, so the next question about the
subject benefits without re-running. Where a web fact contradicts a stored
memory, reconciliation flags it as always and the brief SAYS so (the verify
step reports contradicted/uncertain counts; the prompt requires stating the
tension, never silently preferring either side). Because the brief is
Cogeto-initiated, it speaks `preferred_language` (decision 0052 anchor).

## Named tests

`run_lifecycle`, `gate_preserved`, `no_direct_tasks`, `run_resumable`,
`budget_caps_run`, `brief_integrates_memory`, `brief_cites_web`,
`contradiction_surfaced`, `actions_proposed_not_taken`
(`project/src/connectors/skills/skill-run.integration.spec.ts` +
`skill-brief.integration.spec.ts`); `ambiguous_subject_asks`,
skill-intent detection + precedence
(`project/src/retrieval/skill-intent.spec.ts`,
`project/src/connectors/skills/skill-planner.spec.ts`); the live eval cases
`skill_brief_en` / `skill_brief_hr` (fixture pages, gate auto-approved, folded
`skill` rule verdict) in the chat eval gate.
