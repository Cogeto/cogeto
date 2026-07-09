# Session O2-A — Tasks UI, reminders, the unified digest

**Model:** Opus 4.8. **Implements against (FROZEN):** `docs/handoff/F3-tasks.md`
(tasks UI §4, reminders §2, digest composition §3, shared-scope §5, must-NOTs
§6) and `docs/handoff/F2-dreaming.md` (dream_run contract, digest link
semantics, no second scheduler). **Decision:** `docs/decisions/0018-tasks-ui-reminders-digest.md`.
**Migration:** 0017 (additive reminder columns — pre-approved by F3 §2).

## What shipped

1. **The real Tasks surface** (`project/web/src/pages/Tasks.tsx`) — replaces the
   provisional panel. Views **Open** (open + blocked, due-dated first, "gone
   quiet" badge, condition as "waiting on …"), **Done**, **Dismissed**. Filters:
   person/entity (server-side), plus has-due / gone-quiet / unconfirmed
   (client-side over the capped list). Every row deep-links its **deriving
   memory** (the existing `MemoryDrawer`); settled rows link "closed by this
   memory". Uncertain-derived tasks render softly (amber border + `unconfirmed`
   chip → `/review`). Row actions map ONLY to the three audited engine
   operations (reopen / dismiss / complete). No create UI — tasks derive from
   memory. Empty Open state explains where tasks come from.
2. **Nav badge** = open + blocked, owner-scoped (`GET /api/tasks/count` →
   `countOpenForPrincipal`; wired through `Shell` like the Review/Approvals
   badges).
3. **Reminders** (`TasksEngine.runReminders`) — a graphile-cron job (03:40, one
   new crontab LINE + task in the existing runner; **no second scheduler**).
   Due-based (open/blocked task with `due` inside the 24h horizon, overdue
   included) and dormant-based (`task.dormant` set) triggers. State is two
   **additive columns** on `task` — `due_reminded_at`, `dormant_reminded_at`
   (migration 0017) — not a new table. Stamped once per window ("stamp only when
   NULL" ⇒ idempotent); cleared on close/dismiss/complete and when dormancy
   resolves. Config in one versioned file (`reminders-config.ts`).
4. **The unified digest** — one surface, two sections. Ingestion's
   `DreamingController` now appends a TASKS section to `GET /api/dreaming/latest`
   (never a second endpoint): consolidation lines first (per 0011 order), then
   tasks (due/overdue → newly-unblocked → dormant), tasks capped at 3 with a
   "…and K more tasks" fold. Silent when the run AND the task set are both empty.
   Frontend `DreamDigest` renders the two labelled sections.
5. **Shared-scope reads** (F3 §5) — `listForPrincipal` and the digest now surface
   own + org-shared tasks, each foreign task gated through its deriving memory
   (`getManyForPrincipal`, which enforces scope + org + sensitive). Writes stay
   owner-only. Cross-org and others' private tasks never leak.

## The one real architecture decision: how tasks joins the digest

The digest endpoint lives in **ingestion**, but **tasks already imports
ingestion** (dormant flags, job-type constants) — so ingestion importing tasks
would be a cycle, and boundaries would fail. Resolution (decision 0018): a
**port**. Ingestion OWNS `DIGEST_TASK_SECTION` (token + `DigestTaskSectionPort`
interface); the tasks module IMPLEMENTS it (`TasksDigestSection`) and registers
it as a **global** provider (`TasksModule.forDigest()`), following the codebase's
existing global-seam pattern (MemoryStore, the DB handle). `DreamingController`
injects it `@Optional()` — present in the app process, absent in ingestion-only
tests (where the digest is dreaming-only). Dependency direction stays
tasks → ingestion; `npm run boundaries` is green (no cycle).

## Where the handoff was ambiguous — and how I resolved it (conservatively)

- **Reminder "records" vs. columns.** The O2 prompt says "produces reminder
  records"; the FROZEN contract (§2) says reminder state is a "last-reminded-at
  … column addition on `task` — additive only, owner sign-off for anything
  else." The frozen contract wins: reminders are two nullable timestamps on
  `task`, not a new table. The named tests (`reminder_idempotent`,
  `reminder_clears_on_close`) are satisfied by the per-task/per-window stamp.
- **Task-line link target.** §3 allows `/tasks` OR
  `/memories?open={deriving fact}`. I link task lines to **`/tasks`** (the
  actionable surface — you go there to complete/dismiss). Gating is enforced in
  code regardless of href: a line is emitted only when the deriving memory is
  readable, so the "no line for what the caller cannot read" rule holds.
- **"Newly unblocked since the last run."** No `unblocked_at` column exists;
  the reminders pass deliberately does not touch `updated_at`, so I use
  `condition_met` + `status = open` + `updated_at >= run.scope_from` as the
  "since the last run" anchor. Skipped entirely when no run exists (no anchor).
- **Badge scope.** §4 says "gated to the Principal"; the Open view is org-wide
  for shared tasks. I read the badge as your OWN workload (owner-scoped
  open + blocked) — mirrors the Review badge (your queue, not everyone's). This
  can differ from the Open list count when shared tasks exist (none until the
  O2-B org second-user flow lands).
- **Dormancy window reuse.** §2 says reuse F2's flag window rather than redefine.
  The reminders pass reacts to `task.dormant`, which the engine already syncs
  from `dormant_flag` (F2's `DORMANT_SILENCE_DAYS = 14`). No day-count is
  recomputed in tasks — the window is reused via the flag.

## Must-NOTs — honoured (F3 §6 / F2 §4)

- No task writes outside the engine + the three audited user ops. The reminders
  pass and shared-scope reads are engine/module code; the digest section is a
  pure read. `tasks_read_only_memory` stays green (no memory mutation).
- No second scheduler — one more crontab line in the one graphile runner
  (`no_second_scheduler` static test pins this). No digest writes outside
  dream_run/dream_action (the tasks section is a read). No new status
  transitions.

## Named tests (all green)

`reminder_idempotent`, `reminder_clears_on_close` (+ `reminder_resolved_dormancy_clears`),
`digest_composition`, `digest_silent_when_empty`, `tasks_ui_actions_audited`,
`task_badge_counts`, `no_second_scheduler`. See the report for the full battery.
