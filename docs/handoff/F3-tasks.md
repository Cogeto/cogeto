# Handoff F3 → O2: tasks UI, reminders, digest — the contracts

**Status: FROZEN.** O2 implements against this spec without redesigning it;
deviations need owner sign-off first. Authority: decision 0013, migration
0014, docs/handoff/F2-dreaming.md, scope §3/§4.7.

## 1. The task table and operations (engine-only writes)

- `task` (migration 0014): `id · owner_id · scope` (inherited from the
  deriving memory) `· derived_from_memory_id NOT NULL UNIQUE (FK CASCADE) ·
  title · primary_person · entities[] · condition_text · condition_met ·
  condition_met_by_memory_id · due · status(open | blocked_on_condition |
  done | dismissed) · closed_by_memory_id · dormant · from_uncertain ·
  timestamps`.
- **Derivation is engine-only** (kind commitment/open_loop on admission;
  backfill nightly + once at migration). The model never decides WHETHER.
  Supersession re-points to the chain head; a head that already carries a
  task dismisses the duplicate (`superseded_duplicate`).
- **User operations** (already implemented, audited, owner-checked,
  idempotent): `POST /api/tasks/:id/reopen | dismiss | complete`. Reopen
  restores `blocked_on_condition` when a condition is present and unmet, else
  `open`, and clears closure fields. The engine never un-does a user
  decision. O2 builds UI on these — no new write paths.
- Reads: `GET /api/tasks?status=&entity=&includeSettled=` (owner-scoped).

## 2. Reminders contract (O2 implements)

- **Triggers:** due-based (task `open`/`blocked_on_condition` with
  `due <= now + horizon`; horizon config, default 24h) and dormant-based
  (task.dormant flips true — the F2 silence window already decided "quiet").
- **Scheduler: REUSE graphile cron in the worker** — one new crontab line +
  task (the sweep/dreaming pattern). NO new scheduler, no setInterval, no
  external cron.
- **Delivery surface now = the digest panel** (see §3): reminders render as
  digest lines. The tappable morning chat card is v1.x per the F2 handoff §2
  — reminders join THAT card when it lands, not a separate notification
  channel. No email/push in O2.
- Reminder state (last-reminded-at per task, to avoid nagging) is an O2
  column addition on `task` — additive only, owner sign-off for anything
  else.

## 3. Daily digest composition (tasks join the F2 dreaming digest)

- One digest, one endpoint: extend `GET /api/dreaming/latest`'s panel with a
  TASKS section — never a second digest. Ordering: dreaming's own lines first
  (conflicts → merges → updates → quiet → outdated, per 0011 ruling 5), then
  tasks: due-today/overdue first, then newly unblocked (condition met since
  the last run), then dormant nudges. Caps: the panel's total stays ≤ 6 lines
  BEFORE the tasks section; the tasks section adds at most 3, overflow folds
  into "…and K more tasks" → `/tasks`.
- Link semantics: task lines deep-link `/tasks` (list) or
  `/memories?open={derived_from_memory_id}` (the deriving fact); same
  gate-scoped resolution as every digest line — no line for what the caller
  cannot read.

## 4. The real Tasks UI (replaces the provisional panel)

- Views: **Open** (default: open + blocked, due-dated first, dormant badge,
  condition shown as "waiting on …"), **Done**, **Dismissed**. Filters:
  person/entity, due window, dormant-only, `from_uncertain` (unconfirmed).
- Badge: nav count = open + blocked (mirror of the Review badge pattern).
- Every task row links its deriving memory (drawer) — provenance visible, as
  everywhere else. Closure shows "closed by" with that memory linked.
- Empty states: Open → "Nothing is still open — commitments you capture
  become tasks automatically." Done/Dismissed → plain "none yet".
- Uncertain-derived tasks render softly (unconfirmed chip) and link to
  Review.

## 5. Shared-scope tasks (frozen behavior)

Tasks inherit the deriving memory's scope. A `shared`-scope task is **visible
org-wide, read-only**: any org member sees it in lists and digests (subject
to the memory gates for its deriving fact), but reopen / dismiss / complete
remain **owner-only** — the machine derived it from the owner's memory, and
only the owner (or the engine) settles it. No delegation/assignment in O2;
that is a product decision for later, not a default.

## 6. What O2 (and everyone after) must NOT do

- **No task writes outside the engine and the three audited user
  operations.** No direct INSERT/UPDATE on `task` from UI handlers, digests,
  reminders, or migrations (backfill goes through the engine job).
- **No memory mutations from tasks, ever.** Closure and condition events are
  observations about tasks; no memory status moves because a task did. The
  `tasks_read_only_memory` test pins this — keep it green.
- **No schema changes without owner sign-off** (additive reminder columns
  per §2 excepted, pre-approved here).
- **No second scheduler, no digest writes outside dream_run/dream_action**
  (F2 handoff §4 still binds).
- Dormant flags: read and clear ONLY via ingestion's public API
  (`listOpenDormantFlags` / `clearDormantFlag`); the engine clears on
  close/dismiss — O2's UI never touches flags directly.
