# Task-derivation discipline (P6.5)

**Decision [0054](../decisions/0054-task-derivation-discipline.md) · migration
0030 · issues #240/#241/#242.**

Tasks used to derive from any source whose content sounded commitment-shaped,
so a web research or a dense uploaded document created phantom tasks from
obligations that belong to the world. This unit fixes the rule at its root,
adds the deliberate adoption path, cleans up the damage, and locks the
behaviour with eval traps.

## The rule

Tasks derive ONLY from first-person sources — content the user authored or
adopted:

- `user_note`, `chat` → derive.
- `email` → only the new content of a message the user wrote or sent
  themselves; quoted history, forwarded originals, and inbound senders' words
  never derive. Unknown authorship never derives.
- `file`, `web`, `calendar_event`, `task_conclusion` → never derive.

One pure predicate (`firstPersonSource` in
`project/src/tasks/derivation-rule.ts`) is used by live derivation, the
nightly backfill (which pre-0054 bypassed the gate — fixed), the cleanup, and
the golden traps.

Observed obligations remain FULL memories — extracted, verified, retrievable,
citable, temporal. Only task creation is restricted. Condition satisfaction
and closure stay source-agnostic: a web fact or an inbound email can still
unblock or close your existing task.

## The email split

- Intake (decision 0031 routing) persists `email_message.authored_by_owner`:
  true on the SPF-authenticated self-route, false on the allowlist route.
- The SourceReader combines it with `isolateEmailContentDetailed` (was the
  extracted content a forwarded original's inner text, or the quoted-history
  fallback?) into `memory.authored_by_user` on every fact from that email.
- "I'll send the proposal by Friday" in your own reply → your task. The same
  sentence in quoted history or a forwarded original → a memory, no task. A
  sender's "I'll send you the export by Monday" → a memory that can satisfy
  your task's condition, no task of yours.
- Historical email rows are classified once by the `email_authorship_backfill`
  job (from-address match + forward detection), which then chains the cleanup.

## Adoption ("Make this a task")

- Memory drawer → Actions → **Make this a task** (any memory you own), or chat:
  "make a task from Ana's deadline in that contract", "turn that into a task",
  "napravi zadatak iz …". Ambiguous references list candidates and ask; no
  match declines toward the drawer button.
- `POST /api/tasks/adopt { memoryId }` derives through the EXISTING engine
  (same title/condition/due mapping), sets `task.adopted`, audits
  `task.adopted` as the user, and is idempotent. Adopted tasks then behave
  like any other (conditions, closure, conclusion memories per 0037); the
  Tasks page badges them "adopted".

## The cleanup migration

Migration 0030 → `email_authorship_backfill` → `tasks_derivation_cleanup`:
removes tasks whose deriving memory is non-first-person under the new rule.
Hard delete with one `task.removed` audit entry per row (cause
`derivation_rule_migration`) plus a summary entry; deriving memories stay.
NEVER touched: adopted tasks, anything the user ever completed / dismissed /
reopened, and tasks referenced by a conclusion memory. Idempotent; the worker
logs the counts (removed / spared-by-interaction / spared-by-conclusion) —
check them with `docker compose logs worker | grep "derivation cleanup"`.

## The traps

Golden cases `en-w002`/`hr-w002` (web), `en-f001`/`hr-f001` (document), and
`en-e004`/`hr-e004` (own reply + quoted history) hard-assert task counts
(`expected_tasks`) against the real predicate as part of the standard
eval gate. See the golden [`CHANGELOG`](../../project/eval/golden/CHANGELOG.md).

## Named tests

`derive_notes_chat_only_plus_own_email`, `email_quoted_never_derives`,
`inbound_sender_commitment`, `authorship_uncertain_no_derive`,
`conditions_still_source_agnostic`, `adopt_from_memory`, `adopt_via_chat`,
`adopted_task_full_lifecycle`, `migration_counts`, `migration_idempotent`,
`migration_audited`, `derivation_trap_eval`, `email_authorship_flag`,
`email_authorship_backfill`.
