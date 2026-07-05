# 0012 — Temporal retrieval rulings (Session F3-A)

**Date:** 2026-07-05 · **Status:** accepted · **Governs:** the interval
convention and its single shared predicate, temporal-mode activation, what
point-in-time and change queries return, temporal score multipliers, and past
framing in answers. **Driven by:** Addendum §A.5 (temporal lift) / §B.2,
research temporal-knowledge-patterns (bi-temporal model, §5 point-in-time
WHERE clause), and the F3-A owner prompt. Migration this session is **0013**
(indexes only).

## Ruling 1 — Interval convention: [effective_from, valid_until), one predicate

Intervals are **half-open**: `[valid_from, valid_until)`. NULL `valid_from`
means "since ingestion" — `created_at` is the effective lower bound for
point-in-time evaluation. NULL `valid_until` means "still holding".

> A fact **holds at t** iff
> `COALESCE(valid_from, created_at) <= t AND (valid_until IS NULL OR t < valid_until)`

Boundary semantics that follow: a fact holds AT its `valid_from` instant; it
does NOT hold at its `valid_until` instant (supersession sets the successor's
`valid_from` = the predecessor's `valid_until`, so at the boundary exactly one
of the two holds — no gap, no overlap). This predicate exists ONCE:
`memory/domain/interval.ts` exports the SQL fragment (`intervalHoldsAtSql`)
and its pure TS twin (`intervalHoldsAt`), tested against each other on a truth
table (`interval_predicate_matrix`). No query, view, or answer-side check may
hand-roll it.

*Rationale:* half-open intervals compose under supersession without boundary
double-counting; event time is `valid_from/valid_until`, ingestion time is
`created_at` (research §1) — using `created_at` as the fallback lower bound
keeps "the system knew it then" honest for facts with no stated event time.

## Ruling 2 — Temporal mode is explicit, never inferred silently

Temporal mode activates ONLY when the query-understanding step classifies
temporal intent, double-guarded deterministically:

1. **Enable guard:** the rewriter is consulted for temporal intent only when
   the RAW question matches the temporal-hint lexicon (en + hr: "previously /
   used to / before / what changed / since / month names / prije / prošli /
   nekad / što se promijenilo / hr month names…"). No hint → the question can
   never classify temporal, whatever the model says.
2. **Veto guard:** a model classification without a matching hint in the raw
   question is discarded (guards hallucinated intent).

Date resolution is deterministic: the rewriter returns the temporal KIND plus
the raw `expression` verbatim; code resolves it with the S3.5 chrono resolver
(`resolveExpression`, reused via ingestion's public interface — never
duplicated), anchored to now. Any resolution failure → default mode, never an
error. Default retrieval is byte-for-byte unchanged: `replaced` ×0, `outdated`
×0.2.

## Ruling 3 — Point-in-time results: every lifecycle status, gates untouched

`pointInTime(principal, t, …)` returns memories whose interval covered `t`
**in any lifecycle status** (`replaced` and `outdated` included — they are the
point of the query), each carrying its CURRENT status and `superseded_by`
pointer so the answer can frame past belief honestly. The scope and sensitive
hard gates apply unchanged in every mode — **temporal never weakens a hard
gate**; time travel does not cross owners or reveal sensitive rows without
the same explicit opt-in as today.

Candidates are fetched **temporally in SQL first**, then ranked: Qdrant
participates only for relevance ordering within the temporal candidate set.
Reason, recorded: the Qdrant payload carries `valid_until` but cannot express
the full predicate — the NULL-`valid_from` fallback to `created_at` and the
NULL-`valid_until` "still holding" arm are Postgres semantics on the source of
truth; a payload-side approximation would silently drop or include edge rows,
and §A.4 makes Postgres the truth for exactly this kind of question.

## Ruling 4 — Change queries: the exact event set

`changesSince(principal, since, …)` returns, for the caller's visible
memories, events at `t >= since`, newest first, capped:

| kind | source | detail |
|---|---|---|
| `learned` | memory rows with `created_at >= since` (gated read) | the new memory + its provenance |
| `status_changed` | audit actions `memory.status_transition`, `memory.contradiction_dismiss_restored`, `memory.contradiction_lifted` | from → to, actor, reason |
| `superseded` | audit actions `memory.superseded`, `memory.merged` | the closed memory + its successor pointer (+ the successor's provenance as the causing source) |

Deliberately excluded: sensitive toggles (metadata, not a fact change),
`memory.contradiction_detected` relation bookkeeping (both parties' transitions
already appear), `memory.edited` (its supersession + the successor's `learned`
event already tell the story), and deletions — erased memories resolve to no
row and produce no event; their ledger is the Forgotten section, and change
answers must not reconstruct erased content (§B.1).

## Ruling 5 — 'previous' mode: lifted multipliers, not lifted gates

The `previous` kind runs the standard fused hybrid search with a temporal
multiplier table replacing the §A.5 defaults:
`active`/`user_approved` ×1.0, **`replaced` ×0.9, `outdated` ×0.9**,
`uncertain` ×0.6, `contradicted` ×0.4. Past facts are the point of the query,
so they rank nearly on par; statuses remain multipliers, gates remain gates.
The successor of a surfaced `replaced` fact is attached via its pointer and is
almost always independently retrieved (it is active and topical).

## Ruling 6 — Past framing is a data contract, not a prompt hope

A fact is **past belief** iff its current status is `replaced` or `outdated`,
OR its interval is closed with `valid_until <= now` (evaluated by the shared
TS twin). The chat layer marks such facts (`pastBelief: true`, with
`supersededBy`) in the DTO; `answer/v0003` is REQUIRED to present them as past
belief with what superseded them ("Until March you had X; since then Y") and
never as current fact; the UI renders them with a muted "past" chip variant.
The marker travels with the fact so the contract is testable without a model
(`past_framing_contract`).
