# 0018 — Tasks UI, reminders, and the unified digest (O2-A)

**Status:** Accepted. **Context:** Session O2-A implements the FROZEN
`docs/handoff/F3-tasks.md` (§2 reminders, §3 digest, §4 UI, §5 shared scope,
§6 must-NOTs) on top of F2's dreaming digest and dormant-flag contracts.
Binding authority remains the Addendum and the handoffs; this record fixes the
implementation choices O2-A made where they were load-bearing.

## Rulings

1. **Reminders are additive columns on `task`, not a new table.** The frozen
   contract (§2) pre-approves "a last-reminded-at column addition on `task` —
   additive only." Migration 0017 adds `due_reminded_at` and `dormant_reminded_at`
   (both nullable). A set timestamp = a pending reminder of that kind. Any table
   would have needed owner sign-off; the contract did not grant it.

2. **Reminders reuse the one scheduler.** `TasksEngine.runReminders` is a
   graphile-cron task on a single new crontab line (03:40, after the 03:30
   dreaming cycle so dormancy sync has run). No `setInterval`, no external cron,
   no second runner. Idempotent by "stamp only when NULL"; cleared on
   close/dismiss/complete and when `task.dormant` resolves. The dormancy WINDOW
   is not redefined — the pass reacts to `task.dormant`, already synced from
   F2's `dormant_flag` (14-day window). Pinned by `no_second_scheduler`.

3. **The tasks section joins the digest through a port, not an import.** The
   digest endpoint (`GET /api/dreaming/latest`) lives in ingestion; tasks already
   depends on ingestion, so ingestion depending on tasks would be a cycle.
   Therefore ingestion OWNS an injection port (`DIGEST_TASK_SECTION` +
   `DigestTaskSectionPort`) and the tasks module IMPLEMENTS it
   (`TasksDigestSection`), registered as a **global** provider
   (`TasksModule.forDigest()`) and injected `@Optional()` into
   `DreamingController`. Dependency direction stays tasks → ingestion; the module
   graph is acyclic. This mirrors the existing global-seam pattern (MemoryStore,
   DB handle). It is NOT a second digest and NOT a second pipeline — a pure read.

4. **Digest task lines link to `/tasks`; gating is by the deriving memory.** §3
   permits `/tasks` or `/memories?open={deriving fact}`. Task lines link to
   `/tasks` (the actionable surface), but a line is emitted only when the
   deriving memory is readable by the caller — the same gate as every digest
   line. Ordering: consolidation (0011 order) first, then tasks
   (due/overdue → newly-unblocked → dormant); tasks capped at 3 with a fold.

5. **The nav badge is owner-scoped; the Open view is org-wide.** "Gated to the
   Principal" (§4) reads as the caller's own open + blocked count (mirrors the
   Review badge). Shared-scope tasks (§5) are visible org-wide in lists and
   digests — gated through their deriving memory — but reopen/dismiss/complete
   remain owner-only, and the badge counts only your own workload. The two can
   differ once a second org user exists (O2-B).

## Consequences

- Migration 0017 is additive and reversible; no `task` semantics changed.
- `TaskDto` gains `updatedAt`; `DreamDigestLine` gains an optional `section`.
- Tasks still never mutate memory (invariant held; `tasks_read_only_memory`
  green). No new memory status transitions were introduced.
