# Named skills (Priority 7)

**Decision [0059](../decisions/0059-named-skills.md) · migration 0034 ·
prompts `skill_plan/v0001` + `skill_brief/v0001` · issues #261/#262/#263.**

The visible payoff of everything underneath: agents whose every step is
inspectable, every fact sourced, and every consequential action waits for the
user. v1 ships ONE skill, end to end: **research a company or person before a
meeting** (`skills/research_brief/v0001`).

## The skill model

- A skill is a **named, versioned, code-defined** plan of typed steps
  (`gather_from_memory`, `propose_searches`, `gated_search`,
  `fetch_and_extract`, `verify`, `synthesise`, `propose_actions`) — a registry
  like prompts (`connectors/skills/skill-registry.ts`), never user-programmable
  in v1.
- One `skill_run` row per invocation; one `skill_run_step` row per plan step
  with status, inputs/outputs summaries, and `links` to every artifact it
  produced. **The step log IS the inspectability claim** — a finished run reads
  complete forever, every search sent, page fetched, memory created and the
  brief one click away.
- The runtime lives in **connectors**, beside the research machinery it
  orchestrates (agents would cycle: connectors already imports the approval
  service). Governance flows THROUGH the existing machines, never around them.

## Governance, unchanged by construction

- **The gate at plan granularity**: a skill's queries are N ordinary
  `research_run` rows tagged `skill_run_id`, shown together; the user approves
  in ONE interaction (approve all, edit any, remove any). Discovery still runs
  only from an approved run; `sent_query` is immutable; provenance
  (memory → web_page → research_run.sent_query) is byte-identical to manual
  research. Removal = the ordinary cancel.
- **Minimisation at generation**: skill queries are generated, not user-typed,
  so `skill_plan/v0001` produces least-identifying queries directly; the gate
  remains the guarantee, and a planning-model failure falls open to
  deterministic identity+news queries with an honest reason (the 0044 rule).
- **No direct tasks, ever** (decision 0054 intact): observed obligations stay
  memories; the brief PROPOSES adoptions (`proposed_actions` on the run);
  accepting goes through `POST /api/tasks/adopt` (audited `task.adopted`);
  the skill surface only records accepted/dismissed.
- **Budgets**: `COGETO_SKILL_MAX_QUERIES` (6), `COGETO_SKILL_PAGES_PER_QUERY`
  (3, clamped to the per-run page cap); the daily research budgets apply
  unchanged inside `ResearchService`. Caps degrade gracefully — remaining work
  is skipped with an honest note and the run completes with what it has.

## Execution shape

Planning (entity-profile gather + one `skill_plan` call) runs in the propose
request and stops at `awaiting_approval` — the pause is the row, not a
connection. After approval, the worker's re-runnable `skill.advance` job
claims steps (compare-and-set on `skill_run_step`), searches and captures via
`ResearchService` verbatim, and stops at `read_pages` until the 0057
settle-watcher fires: for skill-owned runs, `afterPageProcessed` enqueues
`skill.advance` when ALL pages of ALL the skill's research runs settle
(instead of `research.conclude` — skill research runs stay `approved`, the
brief is the conclusion). Then verify (reads the pipeline's verdicts and
reconciliation statuses — contradictions are counted and surfaced, never
silently resolved), the one answer-tier `skill_brief` call ([M#]/[W#] markers,
`(unsourced)` tags, unresolvable markers stripped), and deterministic adoption
proposals (commitment/open_loop memories from non-first-person sources).

The brief is durable on the run row (`brief` + `briefCitations`), renders with
live citation links, exports as text with a resolved Sources block, and speaks
`preferred_language` (Cogeto-initiated → the 0052 anchor, forced via the
strict LANGUAGE line).

## Surfaces

- **Chat**: `detectSkillBriefIntent` (before the research patterns) — "prep me
  on Marko", "brief me on X", "research X before Thursday"; hr "pripremi me za
  (sastanak s) X", "istraži X prije …". The turn only starts planning; the
  done event carries `skillRun.runId` and the reply links to the run view.
- **Skills page** (`/skills`): the entry card + runs list; `?run=<id>` is the
  run view — live step log (poll 2.5 s while planning/running), the plan gate
  inline, the brief with clickable citations, accept/dismiss proposals. A
  quiet pointer card sits on the Dashboard.
- The seam mirrors research: `CHAT_SKILL_RESOLVER` port in retrieval,
  `ChatSkillResolver` in connectors, bound by the app-only `SkillsModule`
  (planning needs retrieval; the worker's skill intent stays inert).

## Adding a second skill

1. Add a `SkillDefinition` (id, `v0001`, steps) to the registry, and its
   prompt families under `project/prompts/` (registered in `worker.ts`).
2. Give the engine its step handlers (or reuse the research-brief ones where
   the kinds match); planning stays in `SkillPlanner` if it needs retrieval.
3. Nothing else moves: `skill_run`/`skill_run_step`, the plan gate, budgets,
   the no-direct-tasks rule, the surface, and the eval shape are shared.

**Why one skill first** (the backlog's own rule): the runtime, the governance
seams, the surface and the eval harness are the expensive part; the skill on
top is thin. Shipping one end to end proves the claim and leaves a paved road;
"prepare me for tomorrow" and the weekly review are definitions away, not
architecture away.

## Evals and demo

- `skill_brief_en` + `skill_brief_hr` in the chat eval: fixture pages, LIVE
  planning + brief; the harness stands in at the gate (approves two queries,
  removes the rest) and for the worker; the folded `skill` rule verdict gates
  on completion, log completeness, memory + web citations, contradiction
  surfacing, zero tasks, and the brief's anchor language.
- The Ana sandbox never live-searches (decision 0059): on a demo instance,
  discovery/fetch serve `project/demo/seed/web-fixtures.json` (Adriatic
  Foods, fictional), so the whole skill demos end to end; the capabilities
  panel states the fixture posture honestly.

## Named tests

`run_lifecycle`, `gate_preserved`, `no_direct_tasks`,
`actions_proposed_not_taken`, `run_resumable`, `budget_caps_run`
(`connectors/skills/skill-run.integration.spec.ts`);
`brief_integrates_memory`, `brief_cites_web`, `contradiction_surfaced`,
anchor-language, web-memory persistence
(`connectors/skills/skill-brief.integration.spec.ts`);
`ambiguous_subject_asks` + the pure ambiguity/fallback/page-selection rules
(`connectors/skills/skill-planner.spec.ts`); intent patterns + precedence
(`retrieval/skill-intent.spec.ts`); run-view phrasing + export
(`web/src/components/skills-model.spec.ts`).

## Gotchas for future sessions

- `connectors` already imports `agents` (email drafts) — a skill runtime in
  `agents` cycles. It lives in connectors on purpose.
- The settle-watcher branch keys on `research_run.skill_run_id`; a skill
  research run must never reach `research.conclude` (no per-run answers).
- The eval harness marks pages settled by inserting the `job_execution` claim
  row itself — the engine's `read_pages` reads the queue ledgers, not flags.
- The brief forces the strict LANGUAGE line (`{ ...record, languageStrict:
  true }`) because Cogeto initiates it; do the same for any future
  skill-initiated synthesis.
