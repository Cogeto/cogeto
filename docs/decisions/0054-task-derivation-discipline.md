# 0054 — Task-derivation discipline: the first-person rule

**Date:** 2026-07-24 · **Status:** accepted · **Governs:** which sources may
derive tasks, the structural email-authorship split, the adopt-as-task path,
the cleanup of pre-rule phantom tasks, and the eval traps that lock the rule
(P6.5; issues #240/#241/#242). **Driven by:** decision 0013 (derivation is
deterministic), 0037 (conclusion memories; its ruling-6 loop guard is subsumed
here), 0038 (create_task chat intent), 0031 (sender-routed inbound email), and
the P6.5 owner prompt. Migration this session is **0030**.

Before this record, tasks derived from ANY source whose extracted content was
kind `commitment`/`open_loop` — so researching a website or uploading a
contract created dozens of phantom tasks from obligations that belong to the
world, not the user. The standing bias resolves the trade-off: **a missed task
is recoverable via adoption; a phantom task corrodes trust.**

## Ruling 1 — Tasks derive ONLY from first-person sources

A task is derived only from content the user **authored or adopted**. By
`source_type`:

| source_type | derives? |
|---|---|
| `user_note` | yes |
| `chat` (the user's own captured statements) | yes |
| `email` | ONLY the new content of a message the user wrote or sent (`authored_by_user = true`); quoted history, forwarded originals, and inbound senders' messages NEVER derive |
| `file` (uploaded documents) | never |
| `web` | never |
| `task_conclusion` and any system-derived type (`calendar_event` included) | never — no loops |

If provenance cannot determine authorship confidently (`authored_by_user`
NULL), it does **not** derive. The rule lives in ONE pure predicate
(`firstPersonSource`, `project/src/tasks/derivation-rule.ts`) used by the live
derivation gate, the backfill, the cleanup classification, and the golden-set
traps — the 0037 loop guard is subsumed by it (a `task_conclusion` source is
never first-person, so conclude → derive → conclude still cannot cycle).

**The backfill honours the same gate.** Pre-0054 the nightly/migration
backfill bypassed `derivable()` entirely; it now filters through it, or the
cleanup's removals would silently re-derive every night.

## Ruling 2 — The email split is structural, never a model judgment

The thread-aware isolation (O4) already separates a message's new content from
quoted history. Authorship is now derived from message metadata, on two axes:

- **Routing (intake time, persisted as `email_message.authored_by_owner`):**
  decision 0031's rule-1 self-route (the SPF-authenticated sender IS the
  capture user) means the user wrote/sent the message → true. The allowlist
  route (someone else writing TO the user) → false.
- **Body shape (reader time):** `isolateEmailContentDetailed` reports whether
  the extracted content is a forwarded original's inner text or the
  quoted-history fallback — in either case the words are someone else's.

`authored_by_user` on the derived memories = `authored_by_owner` AND not
forwarded AND not quoted-fallback. So: "I'll send the proposal by Friday" in
the user's own reply derives; the same sentence inside quoted history or a
forwarded original's body is observed — a memory, not a task. An inbound
sender's promise ("I'll send you the export by Monday") becomes a memory and
may satisfy conditions or close the user's tasks, but derives nothing. No
extraction-prompt change: the extractor still never decides WHETHER (0013
ruling 2), and authorship is identifiable structurally.

**Historical rows** (pre-0030, `authored_by_owner` NULL) are classified once
by the `email_authorship_backfill` job: from-address match against the owner's
registered address (SPF cannot be re-checked historically; the from-match is
the best available evidence and is accepted for the one-shot classification),
plus the same forward/quote detection, stamped onto their memories via a
narrow MemoryStore system setter (provenance metadata only — no status
transition, so the aggregate's transition rules are untouched).

## Ruling 3 — Observed obligations remain full memories; settlement stays source-agnostic

The rule governs task **creation** only. Observed obligations are still
extracted, verified, embedded, retrievable, citable, and temporal — nobody may
later "fix" extraction to skip them; the golden `must_extract` labels on the
trap cases pin this. Condition satisfaction and closure detection remain
**source-agnostic**: a web page or an inbound email may still satisfy a
condition or close an existing task — observing the world completing your loop
is correct. The F3 uncertain-status ruling stands unchanged: uncertain
first-person commitments still derive with `from_uncertain`.

## Ruling 4 — Adoption is the deliberate first-person act

Some observed obligations genuinely are the user's to own. **"Make this a
task"** (memory drawer; `POST /api/tasks/adopt`; the chat form "make a task
from …" / "turn … into a task" / "napravi zadatak iz …", reusing the
create_task intent's ask-when-ambiguous posture) derives a task from any
memory the caller owns through the EXISTING engine mapping (title, condition,
due, scope), with `task.adopted = true` and a `task.adopted` audit entry under
the user actor. Adoption ignores the source type — the adoption itself is the
first-person act. Adopted tasks behave identically afterwards: conditions,
closure, and conclusion memories per 0037 (the conclusion derives from the
engine regardless of the original source, since adoption made it
first-person). Idempotent by the UNIQUE deriving-memory constraint: adopting
an already-tasked memory returns the task unchanged. The chat resolution is
gated retrieval over the caller's OWN memories; one confident match adopts,
several candidates ask, none declines toward the drawer button.

## Ruling 5 — Cleanup: hard delete with audit, sparing every user-touched task

Migration 0030 adds the three columns and starts the one-shot chain
(authorship backfill → `tasks_derivation_cleanup`), guarded like 0014 on fresh
clones. The cleanup classifies every task by its deriving memory under
ruling 1:

- **Candidates:** deriving memory `file`/`web`/`calendar_event`/
  `task_conclusion`, or `email` now classified non-first-person.
- **NEVER touched:** adopted tasks; tasks with ANY `user:` audit action
  (complete, dismiss, reopen — interaction is adoption); tasks referenced by a
  conclusion memory. These stay regardless of origin.
- **Action:** **hard delete of the task rows** — chosen over a
  `migrated_away` status because the rows were never valid derivations, a
  parked status would pollute every engine candidate pool, UI filter, and
  count forever, the deriving MEMORIES stay untouched, and the audit trail
  (one `task.removed` entry per row with cause
  `derivation_rule_migration` + the deriving memory and its source type, plus
  a `task.derivation_cleanup` summary entry) preserves what was removed and
  why. Any wrongly-missed task is one click away via adoption.

Idempotent: a re-run classifies nothing new and deletes nothing. The count
summary (removed / spared-by-interaction / spared-by-conclusion) is logged by
the worker job.

## Ruling 6 — The traps make regression impossible to miss

The golden case schema gains `expected_tasks` (hard assertion) and
`email_authored_by_owner`. Six cases (en + hr): a web page and an uploaded
document dense with obligation language must produce their memories AND zero
tasks; the user's own email reply with one commitment in new text and another
in quoted history must produce exactly one. The eval entrypoint checks them
against the tasks module's REAL predicate (never a reimplementation) as part
of the standard gate — a breach fails the build unconditionally, since it is a
rule regression, not model variance.

## Named tests

`derive_notes_chat_only_plus_own_email`, `email_quoted_never_derives`,
`inbound_sender_commitment`, `authorship_uncertain_no_derive`,
`conditions_still_source_agnostic`, `adopt_from_memory`, `adopt_via_chat`,
`adopted_task_full_lifecycle`, `migration_counts`, `migration_idempotent`,
`migration_audited`, `derivation_trap_eval`
(`project/src/tasks/tasks-derivation-discipline.integration.spec.ts`,
`project/src/retrieval/chat/chat-create-task.integration.spec.ts`);
`email_authorship_flag`, `email_authorship_backfill`
(`project/src/connectors/email-authorship.integration.spec.ts`); the intake
routing assertions in `self_sender_routes` / `copy_to_each`.
