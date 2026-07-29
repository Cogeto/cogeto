# Memory: lifecycle, reconciliation, and time travel

How a fact enters memory, how its status moves, how Cogeto notices that two facts
disagree, and how the past stays readable. This is the core of the product; every
other feature reads through it.

## The row

Every memory carries `owner_id` (NOT NULL), a `scope` enum (`private` | `shared`,
NOT NULL), provenance `source_type` + `source_id` (both NOT NULL, no orphans ever),
a `status`, a `sensitive` boolean, a validity interval, extracted `entities`, an
optional `subject_entity`, and a `kind` (`commitment`, `decision`, `preference`,
`fact`, `open_loop`).

### Six statuses, and one flag beside them

`active` · `outdated` · `contradicted` · `uncertain` · `replaced` · `user_approved`

`sensitive` is a **boolean orthogonal to lifecycle**, not a seventh status. A
sensitive fact can also become outdated; a single enum would have made those
mutually exclusive by construction.

Retrieval rule for `sensitive`: excluded from default retrieval, returned **only to
its owner**, and only on explicit per-query opt-in.

### Who may move a status

Transitions are owned by the `Memory` aggregate and nothing else.

- Only reconciliation sets `contradicted`.
- Only the user sets `user_approved`, and only from `uncertain` or `contradicted`.
- Only the consolidation pass (dreaming) sets `outdated` from a lapsed interval.
- `replaced` is terminal and is only ever reached through supersession.
- Only the deletion saga hard-deletes, with one narrow extension below.

**Editing a memory's content is supersession, never mutation.** An edit creates a
new memory (`user_approved`, same provenance, plus an edit audit entry) and marks
the old one `replaced` with `superseded_by` set. History is never destroyed, and
there is no second write path.

**Rejecting an uncertain memory in review** is the one narrow extension to
"only the saga hard-deletes": it removes the row and its Qdrant point through a
guarded path on the aggregate, audited. A rejected extraction is pipeline noise,
not user data with a source to forget, so a deletion receipt would attest to the
wrong thing while the audit row keeps the removal accountable.

## The gates

Scope and `sensitive` are **hard gates**: WHERE-clause and Qdrant payload
pre-filters inside the query. App-side post-filtering of vector results is
forbidden, because a demoted leak is still a leak.

Statuses are **score multipliers on top of the gates**, never gates themselves.
`replaced` is excluded from default retrieval; temporal queries lift that
exclusion (see below).

The memory module owns every read path, and each primitive requires a `Principal`,
so an unscoped query is unrepresentable in the type system rather than forbidden by
review. Scope changes move the Postgres row and the Qdrant payload together, so a
`shared → private` demote takes effect in vector search the instant it commits.

Search is hybrid: vector similarity, Postgres full-text on the `simple`
configuration over unaccented text (Croatian has no built-in dictionary, and
`simple` + `unaccent` is predictable across languages), and entity matching over a
`text[]` column with a GIN trigram index. Vector scores normalize to [0,1] at the
adapter boundary so fusion has one scale.

## Reconciliation

Stage 6 of the pipeline, and the nightly dreaming cycle in batch: **one service,
two drivers**, so both run inside their job's transaction and neither can drift
from the other.

The calibration stance, binding on everything below:

> A wrong merge destroys a distinct fact, a wrong contradiction wastes the user's
> attention, and both are worse than doing nothing.

Where a rule had a lenient and a conservative reading, the conservative one was
chosen.

### Finding candidates: deterministic, cheap, model-free

No model call happens in candidate generation. Candidates come from committed
memory of the **same owner and same scope**, through the gated primitives, with
rows from the incoming fact's own source excluded. Thresholds live in one versioned
config (`project/src/ingestion/reconcile-config.ts`).

- **Dedup candidates**: embedding similarity ≥ `dedupSimilarity` (0.93), **or**
  entity overlap `|A∩B| / min(|A|,|B|)` ≥ 0.8 with identical `kind`.
- **Contradiction candidates**: equal `subject_entity`, both kinds in
  {fact, decision, preference, commitment}, and similarity in the mid band
  [0.80, 0.93): similar topic, different content.
- **Escalation**: a pair *above* the dedup threshold that the dedup model ruled
  `distinct` is also contradiction-eligible. "Go-live October 1" and "go-live
  September 1" embed nearly identically, and same-slot-different-value is exactly
  what `distinct` flags. Without escalation, high-similarity contradictions would be
  structurally invisible. `related` verdicts do not escalate.

At most three model confirmations per family per fact, best-similarity first; the
first `same_fact` merge stops that fact; at most one contradiction action per fact
per run.

### Merging

Only a `same_fact` verdict merges. `distinct` and `related` change nothing.

Survivor selection is the newer memory by `created_at`, except:

1. the older is `user_approved`, so the older survives (user judgment outranks recency);
2. the newer ranks strictly below the older on `user_approved > active > uncertain`
   (a verified fact never yields to an unverified duplicate of itself);
3. both are `user_approved`, in which case **nothing merges** at all.

The loser becomes `replaced` with `superseded_by` set and its interval closed at the
survivor's start. No row is ever deleted.

**Enrichment** applies only when the dedup prompt returns a `merged_content` that
differs from the survivor's text and the survivor is not `user_approved`: the
survivor is superseded by an enriched successor carrying the union of both entity
sets, and the loser points at that successor. Otherwise the merge is the pointer
alone.

### The `user_approved` shield

Reconciliation never transitions, supersedes, merges, or enriches a `user_approved`
memory, with exactly one exception: pairing it into a `contradicts` relation, which
records its prior status so resolution can restore it. The user is the only one who
resolves against their own confirmations.

### Contradictions

Detected pairs become `memory_relation` rows. Convention: **a** is the incoming
(newer) fact, **b** the existing one, with a unique index on the canonical pair.

**A relation row permanently excludes its pair from re-detection, resolved or not.
Dismissed stays dismissed**: the user has already ruled the pair compatible, and
reconciliation never asks again.

The three resolutions are owner-only, single-transaction, and audited:

- **Confirm A or B.** The confirmed memory goes `contradicted → user_approved`. The
  loser goes to `outdated` if its own interval had already closed before the
  confirmed fact began (it was true and expired on its own, nothing replaced it), or
  otherwise to `replaced` pointing at the confirmed winner.
- **Correct both.** Routes to the edit-as-supersession flow per memory; each is
  superseded by a `user_approved` successor in the same transaction.
- **Dismiss.** Each memory still in `contradicted` is restored to the status
  recorded at detection. A memory the user has since moved by other means is left
  alone, because `replaced` is terminal.

The explanation for *why* a pair was flagged lives on `memory_relation.reason`, the
owner-gated row it serves, and is erased with the pair. It is deliberately not in
the org-wide audit trail, which carries no content.

**Supersession from a contradiction verdict** applies only when the direction is
unambiguous: the model's winner must also be the temporally later memory, and
neither party may be `user_approved`. Any disagreement between model direction and
event order routes to a contradiction instead. Never silent supersession on doubt.

**Cross-owner contradictions are structurally impossible.** Reconciliation only ever
compares a fact with the same owner's, same-scope memories, so every relation is
intra-owner. A shared fact is read by peers but reconciled only within its owner's
memory.

## Dreaming: the nightly consolidation

Incremental by watermark, never a whole-store scan: from the last finished run's
window end to now, grouped per owner, each owner batch in its own transaction. A
crashed run leaves its window uncovered and it is re-covered next time, so the pass
is resumable by construction.

It does three things:

- Runs the reconciliation engine in batch over the window.
- **Staleness**: every `active` memory whose `valid_until` has passed transitions to
  `outdated`. Deterministic, model-free.
- **Dormancy**: an `active` commitment untouched for more than 14 days gets one open
  `dormant_flag` row. The memory's status is **not** touched. Flags clear when the
  memory stops being active.

The batch driver needs instance-wide scans no `Principal` can represent, so the
aggregate exposes four documented, worker-only system reads. Everything they feed
re-applies the per-owner gates before it can reach a user.

### The digest

`GET /api/dreaming/latest` returns at most six lines from the newest finished run,
scoped **by gate rather than by filter**: memory details resolve exclusively through
the caller's gated read, so another owner's actions produce no line at all. Silent
nights produce no card. Overflow beyond six folds into "and K more changes";
trimming priority is conflicts, merges, updates, quiet commitments, then the
staleness aggregate. Line ordering is load-bearing, because the attention feed's
dismissal keys index into it.

## Open loops

The founding question is *what did I decide, promise, and commit to, and what is
still open?* Cogeto answers it **without a task subsystem**: an open loop **is** a
memory whose `kind` is `commitment` or `open_loop` and whose status is `active`,
`user_approved`, or `uncertain`. Its due date is the memory's own `valid_until`;
"gone quiet" is the dormant flag.

`MemoryStore.openLoopsForPrincipal` is the single gated read;
`RetrievalService.openLoops` layers dormancy on top and is what **both** the chat
answer and the attention surface call, so there is one definition of "still open"
in the product rather than two that can drift.

Statuses that no longer stand (`outdated`, `replaced`, `contradicted`) are excluded
structurally, so a settled obligation cannot reach the answer. `uncertain` stays in
and is framed softly: an unconfirmed promise is still a promise.

## Time travel

### One interval predicate, defined once

Intervals are **half-open**: `[valid_from, valid_until)`. A NULL `valid_from` means
"since ingestion", so `created_at` is the effective lower bound. A NULL
`valid_until` means "still holding".

> A fact **holds at t** iff
> `COALESCE(valid_from, created_at) <= t AND (valid_until IS NULL OR t < valid_until)`

A fact holds **at** its `valid_from` instant and does **not** hold at its
`valid_until` instant. Supersession sets the successor's `valid_from` to the
predecessor's `valid_until`, so at the boundary exactly one of the two holds: no
gap, no overlap.

This predicate exists **once**, in `memory/domain/interval.ts`, as a SQL fragment
and a pure TypeScript twin tested against each other on a truth table. No query,
view, or answer-side check may hand-roll it.

### Temporal mode is explicit, never inferred

Two deterministic guards, both required:

1. **Enable guard.** The rewriter is asked about temporal intent only when the raw
   question matches the temporal-hint lexicon (en + hr). No hint means the question
   can never classify as temporal, whatever the model says.
2. **Veto guard.** A model classification with no matching hint in the raw question
   is discarded, which guards against hallucinated intent.

Date resolution is deterministic: the rewriter returns the temporal kind plus the
raw expression verbatim, and code resolves it with the chrono resolver anchored to
now. Any resolution failure falls back to default mode, never an error. Default
retrieval is byte-for-byte unchanged.

### What the modes return

- **Point in time.** Memories whose interval covered `t` in **any** lifecycle status,
  `replaced` and `outdated` included, since they are the point of the query. Each
  carries its current status and `superseded_by`. Candidates are fetched temporally
  in SQL first and Qdrant only orders them, because the Qdrant payload cannot express
  the NULL-`valid_from` fallback or the NULL-`valid_until` arm, and an approximation
  would silently drop edge rows.
- **Previous.** The standard fused search with a temporal multiplier table replacing
  the defaults, so past facts rank nearly on par: `active`/`user_approved` ×1.0,
  `replaced` ×0.9, `outdated` ×0.9, `uncertain` ×0.6, `contradicted` ×0.4.
- **Changes since.** Three event kinds: `learned` (new rows), `status_changed`, and
  `superseded`. Deliberately excluded: sensitive toggles (metadata, not a fact
  change), relation bookkeeping (both parties' transitions already appear), edits
  (the supersession plus the successor's `learned` already tell the story), and
  deletions, whose ledger is Forgotten and which must never be reconstructed here.

**Temporal never weakens a hard gate.** Scope and sensitivity apply unchanged in
every mode; time travel does not cross owners.

### Past framing is a data contract, not a prompt hope

A fact is past belief iff its status is `replaced` or `outdated`, **or** its interval
is closed with `valid_until <= now`. The chat layer marks such facts in the DTO with
`pastBelief` and `supersededBy`; the answer prompt is required to present them as
past belief alongside what superseded them ("Until March you had X; since then Y"),
and the UI renders a muted "past" chip. The marker travels with the fact, so the
contract is testable without a model.
