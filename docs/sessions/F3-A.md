# Session F3-A — temporal retrieval (time-travel memory, §A.5 lift + §B.2)

**Date:** 2026-07-05 · **Decision record:** 0012 · **Migration:** 0013
(interval + audit indexes only — no schema change; the S1 bi-temporal columns
were built for exactly this day). The `outdated`/`replaced` exclusion is now
liftable, point-in-time and change queries are real, and answers frame past
belief honestly. The task engine is F3-B.

## Frozen rulings recap (full text: decisions/0012)

1. **Intervals are `[effective_from, valid_until)` half-open.** NULL
   `valid_from` → `created_at` is the effective lower bound; NULL
   `valid_until` → still holding. A fact holds at t iff
   `COALESCE(valid_from, created_at) <= t AND (valid_until IS NULL OR t <
   valid_until)`. The predicate exists ONCE (`memory/domain/interval.ts`: SQL
   fragment + pure TS twin, truth-table-tested against each other). At a
   supersession boundary exactly one of predecessor/successor holds.
2. **Temporal mode is explicit, double-guarded.** A deterministic hint lexicon
   (en+hr) both ENABLES the rewriter's temporal classification and VETOES any
   classification without a hint in the raw question. Dates resolve via the
   S3.5 chrono resolver (reused through ingestion's public interface), with a
   past-preference policy (a future resolution steps back one year — "in
   March" asked in July means last March). Any failure → default mode.
   Default retrieval is byte-for-byte unchanged.
3. **Point-in-time includes every lifecycle status** (replaced/outdated are
   the point), each with current status + successor pointer; scope and
   sensitive gates hold unchanged — time travel never crosses owners or
   reveals sensitive rows. SQL fetches candidates temporally FIRST; Qdrant
   only ranks within that set (the NULL semantics live in Postgres, the
   source of truth — a payload approximation would lie at the edges).
4. **Change events, exactly:** `learned` (rows created in window),
   `status_changed` (audit: status_transition + the two dismiss/lift
   restorations), `superseded` (audit: superseded + merged, with successor
   pointer). Excluded: sensitive toggles, relation bookkeeping, edits (their
   supersession + successor already tell it), deletions (Forgotten is their
   ledger; change answers never reconstruct erased content).
5. **'previous' lifts multipliers, not gates:** temporal table `replaced` ×0.9,
   `outdated` ×0.9 (rest as §A.5).
6. **Past framing is a data contract:** `pastBelief` = replaced/outdated or
   interval closed before now, computed in code, carried on the fact DTO with
   `supersededBy`; `answer/v0003` must present such facts as past with their
   successor; the UI shows a muted "past" chip. Testable without a model.

## What shipped

- Memory module: `pointInTime` and `changesSince` gated primitives (Principal
  required), the shared interval helper, migration 0013 indexes.
- `query_rewrite/v0002`: temporal classification with en+hr few-shots and the
  "questions ABOUT time, not questions that MENTION time" contrast; the model
  copies date phrases verbatim; code resolves and vetoes.
- Retrieval mode `temporal` routing all three kinds; `answer/v0003` with the
  past-belief contract; `ChatFactDto.pastBelief`/`supersededBy`; muted "past"
  citation chips (warning statuses still win the styling).
- Eval: chat cases `previously_decided`, `point_in_time_march`,
  `changed_since`, `default_no_time_travel` (regression: replaced facts never
  appear without temporal intent) with direct-fact seeding (deterministic
  supersession chains, fixed dates) and a folded `temporal` scoring column;
  golden interval cases `en-0025/26`, `hr-0013/14`. Corpus: en 32 / hr 19.

## Tests (named, all green — 101 passed, 1 live-skipped)

`interval_predicate_matrix` (10-row truth table over NULLs, half-open edges,
created_at fallback — SQL and TS twins agree), `point_in_time_gated` (user
B's and sensitive facts never leak through time; replaced facts return with
current status + pointer; the successor does NOT hold before its interval),
`temporal_explicit_only` (plain questions: no hint → hallucinated
classifications vetoed), `changes_since_events` (exactly the ruled event set,
newest first, other owners invisible), `past_framing_contract` (PAST BELIEF
markers + successor references reach the answer input; current facts carry
none), plus ranking-set containment. Lint, boundaries (197 modules, 0
violations), build green; compose to login with migration 0013 and
query_rewrite/v0002 + answer/v0003 registered.

## Eval results

Golden set (40 cases: en 26 / hr 14, incl. the four new interval cases) —
**all five gates PASS, exit 0**:

| metric | measured | gate |
|---|---|---|
| extraction precision | 77.6% | ≥ 0.70 |
| extraction recall | 91.9% | ≥ 0.80 |
| verification agreement | 86.8% (en 96.0 / hr 69.2 — the hr band stays wide) | ≥ 0.75 |
| dedup accuracy | 92.9% | ≥ 0.90 |
| contradiction recall | 100% | ≥ 0.70 |

Chat eval — **all seven cases PASS, exit 0** (temporal column is the folded
must-include/past-framing/source-status checks):
`previously_decided` PASS ("Previously … on Microsoft Teams; later superseded
by … Zoom" — the replaced fact surfaced, framed past, successor stated),
`point_in_time_march` PASS, `changed_since` PASS, `default_no_time_travel`
PASS (no replaced fact in sources), plus the three pre-existing cases.

Two live findings, both fixed or explained:
- **Entity narrowing must never kill temporal recall.** The first
  `point_in_time_march` run returned zero facts: heuristic query entities
  ("CRM") trigram-missed the stored names and the narrowing was a hard AND.
  Fixed — narrowing falls back to the unfiltered temporal set when empty
  (gates unaffected; covered by the ranking-containment test).
- **`who_is_ana` (14%) / `atlas_scope` (50%) failed one run** on rewriter
  pronoun flakiness (she→Marta — the F1 trap, seen at 13% in an S3.5 run
  predating v0002) and grader variance; both passed the rerun at 86%/100%.
  Not a v0002 regression; noted as known flakiness.

## Notes / limits

- `valid_from` is never NULL on new rows (the aggregate defaults it to
  ingestion time); the predicate's created_at arm covers legacy rows and any
  future writer — tested via forced NULL.
- 'previous' mode's successor attachment rides on the successor being
  independently retrieved (active + topical) plus the pointer; a dedicated
  chain-fetch is v1.x diff-view territory.
- The hint lexicon is deliberately conservative; a missed hint degrades to
  default mode (safe), a false hint still needs the model AND resolution to
  agree. Tune with eval evidence only.
