# Session F3-B — the task-derivation engine (open loops; the day-one job complete)

**Date:** 2026-07-05 · **Decision record:** 0013 · **Migration:** 0014
(`task` table + guarded one-shot backfill enqueue). The Fable block ends
here: the day-one sentence — *"What did I decide, promise, and commit to —
across my email, calendar, and notes — and what's still open?"* — is now
fully answerable at the engine level, and its second half is a measured eval
case. Handoff frozen: `docs/handoff/F3-tasks.md`. Next: O1 (Opus 4.8).

## Frozen rulings recap (full text: decisions/0013)

1. **One task per deriving memory** (UNIQUE, FK CASCADE as safety net),
   scope inherited, following the supersession chain head; a head that
   already carries a task dismisses the re-pointing duplicate
   (`superseded_duplicate`). All state in the row — resumable from the table
   alone (research: state-in-rows).
2. **Derivation is deterministic**: kind `commitment`/`open_loop` on
   admission (active AND uncertain — the latter marked `from_uncertain`;
   Review approval confirms, rejection cascades). The model never decides
   WHETHER; v1 titles are the memory content verbatim (the cosmetic rephrase
   hook exists unused). Condition text via a deterministic
   "after/once/when/nakon što/kad/čim…" clause heuristic. Invocation by
   outbox event (`tasks.derive` after stage 6), nightly + one-shot
   migration-time backfill (graphile-schema-guarded for fresh clones).
3. **Closure and condition are model judgments, biased to no action**:
   deterministic candidates (owner's open tasks sharing an entity/person),
   closure judged before condition, `progresses` deliberately changes
   nothing, cost tables in both prompts ("a wrongly closed task hides an
   obligation"). `task_closure/v0001` + `task_condition/v0001`, registered,
   changelogged.
4. **Statuses**: blocked ⟺ condition present ∧ unmet; done via closure or
   user; dismissed via user only; reopen/dismiss/complete audited and
   owner-checked; the engine never un-does a user decision.
5. **Dormancy consumed per the F2 contract**: `task.dormant` mirrors open
   flags via ingestion's new `listOpenDormantFlags`/`clearDormantFlag` API;
   the engine clears flags on close/dismiss.
6. **Deletion cascade counts tasks**: the new `DERIVED_CASCADES` port (tasks
   implements, roots bind); `counts_json.tasks_removed` additive-optional —
   old receipts parse unchanged, the sweep ignores counts.
7. **The open-loops answer**: `query_rewrite/v0003` open_loops intent
   (hint + veto double guard, entity-scoped), retrieval mode `tasks`,
   `answer/v0004` human rundown (actionable first, blocked with conditions
   in plain words, quiet nudged, settled never shown), zero open loops →
   the canned all-clear, distinct from nothing-on-record.

## The module rule, enforced

`tasks` reads memory ONLY through its public interface and never mutates it —
pinned by `tasks_read_only_memory` (source scan: no memory internals, no
mutating aggregate call) and by dependency-cruiser (206 modules, 0
violations). Closure/condition events are observations on task rows.

## Tests (named, all green — 110 passed, 1 live-skipped)

`derivation_deterministic` (one task, correct mapping incl. condition/due,
idempotent re-run), `supersession_repoints` (edit moves the task to the chain
head, no duplicate), `condition_flow` (blocked → open with cause + audit),
`closure_flow` (done + closed_by + gone from the open list + re-delivery
no-op), `no_false_close_bias` (progresses/not_satisfied change nothing — and
the judge WAS consulted), `open_loops_gated` (owner-scoped lists),
`task_cascade` (source deletion removes the task; receipt records
`tasks_removed: 1`), `tasks_read_only_memory`, plus the audited user-ops
test. Full battery: lint, boundaries, build, compose-to-login green.

## Eval results

**Task pairs (the new F3-B measurement) — perfect on the seeded set:**

| set | closure pairs | closure accuracy | condition pairs | condition accuracy |
|---|---|---|---|---|
| en | 3 | 100% (5/5 weighted) | 2 | 100% (2/2) |
| hr | 3 | 100% (5/5 weighted) | 2 | 100% (2/2) |
| **aggregate** | 6 | **100% (10/10)** | 4 | **100% (4/4)** |

Both weight-2 false-close traps (same person, different deliverable) held —
**zero false closures**, the property that matters most (a false close hides
an obligation).

**Chat eval — all 10 cases PASS, exit 0**, including the three new task cases:
`whats_still_open` (the day-one sentence verbatim — open + blocked tasks
covered, the delivered report excluded), `open_with_entity` (Luka's task
only, Ana's excluded), `closure_flow` (capture → the fulfilling fact closes
the task → gone from the open answer). The recurring `who_is_ana` rewriter
flake (she→Marta, 0–86% across runs) was fixed for real this session by a
multi-person disambiguation example added to `query_rewrite/v0003` ("the
conversation is ABOUT Ana … so 'she' is Ana, not the just-mentioned Marta");
it now passes at 86%.

**Golden + reconciliation — all five §B.4 gates PASS, exit 0** (unchanged by
this session; the new task cases live in their own harness):

| metric | measured | gate |
|---|---|---|
| extraction precision | 75.0% | ≥ 0.70 |
| extraction recall | 87.1% | ≥ 0.80 |
| verification agreement | 92.1% (en 96.0 / hr 84.6) | ≥ 0.75 |
| dedup accuracy | 92.9% | ≥ 0.90 |
| contradiction recall | 100% | ≥ 0.70 |

**Live end-to-end (real stack, not eval containers):** captured "send Luka
the offer after Luka confirms the budget" → task derived
`blocked_on_condition` with the condition text; captured "Luka confirmed the
budget" → the condition judge flipped it to `open` (conditionMet=true);
"What's still open with Luka?" answered "You still need to send Luka the
revised offer. Luka has now confirmed the budget, so this task is
actionable." The migration-time backfill also derived tasks from
pre-F3 commitments on boot (verified: 2 historical tasks present).

## Notes / limits (for O2 and beyond)

- Condition text is a clause heuristic on content (the extractor's
  `condition` field is not stored on the memory row); an `extraction/v0003`
  that persists conditions structurally would upgrade it — owner sign-off
  path, noted, not done.
- Titles are verbatim content; the rephrase call is a sanctioned cosmetic
  upgrade when O2 builds the real UI.
- Shared-scope task behavior (org-visible read-only, owner-only operations)
  is frozen in the handoff; the engine currently lists owner-only — the
  read-only shared view is O2's to build on the frozen rule.
- The dreaming digest does NOT yet include a tasks section — that
  composition contract is frozen in the handoff (§3) for O2, keeping F3-B's
  surface debug-grade as instructed.
