# Temporal knowledge patterns

Distilled from studying a temporal knowledge-graph memory system built around
bi-temporal fact tracking. Pattern → rationale → application; Cogeto mapping at the end.

## 1. Bi-temporal modeling: event time vs ingestion time

**Pattern:** Every fact carries two independent time axes:
- **Event time** — when the fact was/became true in the world (`valid_at`,
  `invalid_at` in the studied system).
- **Ingestion time** — when the system learned it (`created_at`), plus an operational
  marker set at the moment of invalidation (`expired_at`) preserving *when the system
  decided* the fact no longer held.

**Rationale:** Conflating the axes breaks backfill: a historical note imported today
has event time in the past and ingestion time now. Systems keyed only on ingestion
time cannot answer "what was true in March"; systems keyed only on event time cannot
audit their own behavior ("when did we mark this outdated?").

**Application:** Cogeto's `valid_from`/`valid_until` are event time; `created_at`/
`updated_at` are ingestion time; status-transition audit rows carry the decision
moment. All three exist in migration 0001 — adding an axis later is a rewrite.

## 2. Invalidation, never deletion

**Pattern:** Superseded facts are closed, not removed: set `invalid_at`
(event-time end) and the operational marker; the row stays queryable forever.
Deletion is reserved for a distinct, explicit operation (privacy/erasure), never a
side effect of learning something new.

**Rationale:** History-destroying updates make three things impossible: point-in-time
queries, "what changed and why" audits, and undo. The studied system's single most
transferable decision is that *learning a new fact is an interval operation on the
old fact*, not a mutation of it.

**Application:** In Cogeto, supersession = close old interval (`valid_until` :=
new fact's `valid_from`) + status `replaced` + pointer to the successor; the user's
erasure right = the deletion saga — a different code path with a receipt. Keeping
these two operations separate is what makes both the time-travel feature and the
deletion receipt honest.

## 3. Contradiction detection: two candidate sets, not one

**Pattern:** When a new fact arrives, resolution retrieves **two distinct candidate
sets**: (a) facts about the *same subject pair/entity* — duplicate candidates; and
(b) semantically related facts across the graph — contradiction candidates. A single
arbitration call classifies against both lists at once, with an explicit rule:
facts differing in a material detail (a date, an amount) are contradictions, never
duplicates.

**Rationale:** Merging the sets produces the classic failure: a contradicting fact
gets "deduplicated" into the old one and the change of state is lost. The
duplicate/contradiction distinction is exactly the distinction between "append
provenance to the existing fact" and "invalidate the old fact."

**Application:** Cogeto's reconciliation job adopts the two-set structure: duplicate
→ merge provenance, loser `replaced`; contradiction → old fact `contradicted` (or
interval-closed if the new fact clearly supersedes), both facts kept, dashboard
review flag. The material-difference rule goes verbatim into the reconciliation
prompt (a versioned artifact).

## 4. Temporal interval arithmetic for supersession

**Pattern:** Whether a new fact invalidates an old one is decided by interval logic
before any model call:
- old.invalid_at ≤ new.valid_at → old already ended; no action.
- new.invalid_at ≤ old.valid_at → new ended before old began; no action.
- old.valid_at < new.valid_at (overlapping, same claim) → supersession: old.invalid_at
  := new.valid_at.

**Rationale:** Cheap, deterministic, and auditable; the model is consulted only to
decide *whether the claims conflict*, never *what the timestamps imply*.

**Application:** This is the core of Cogeto's interval-maintenance step in
reconciliation (Addendum §B.2 v1: "interval maintenance in reconciliation").
Implement as pure functions with property tests — it is the most unit-testable part
of the whole memory engine.

## 5. Point-in-time queries

**Pattern:** "What was true at T" is a WHERE clause, not a feature:
`valid_at <= T AND (invalid_at > T OR invalid_at IS NULL)` — provided intervals are
maintained and indexed. The studied system stores the fields but leaves filtering to
consumers; production use demands indexes on both interval bounds.

**Application:** Cogeto's temporal retrieval ("what did we previously decide?") lifts
the `outdated`/`replaced` exclusion and applies the interval clause (Addendum §A.5).
Index `valid_from`/`valid_until` in migration 0001. The v1.x diff view ("what changed
about X since March") is two point-in-time queries and a diff — no new machinery if
intervals are right from day one.

## 6. Relative-time resolution at extraction

**Pattern:** Extraction receives an explicit **reference time** (the source item's
own timestamp) and must resolve every relative expression ("last week", "next
quarter") to absolute timestamps against it; facts that are ongoing get
`valid_at := reference_time`, unknown times default rather than fail. A dedicated
lightweight second pass fills missing timestamps instead of bloating the main
extraction prompt.

**Rationale:** Relative times are the highest-frequency temporal bug; resolving them
anywhere but at extraction (while the source context exists) is unrecoverable later.

**Application:** Every Cogeto ingestion job carries the source item's timestamp as
reference time into the extraction prompt. Email/calendar items have natural
reference times; notes use capture time.

## 7. Provenance via source episodes

**Pattern:** The raw source item (message, note, event) is stored as its own record,
and every derived fact carries references back to the source(s) that support it —
enabling debugging ("show me where this came from"), re-extraction with better
prompts, and per-source cascade operations.

**Application:** This is Cogeto's source-link made structural: `source_type` +
`source_id` NOT NULL, and the deletion saga's "every memory derived from this
document" query is exactly a provenance-index lookup. The studied system proves the
pattern scales; Cogeto's constraint (NOT NULL, no orphans ever) is stricter than
anything studied — deliberately.

## 8. What NOT to copy (complexity budget)

The studied system pays costs a per-tenant product must refuse:

- **3–5 model calls per ingested item** (extract nodes → edges → attributes →
  timestamps) plus per-edge arbitration calls. Cogeto batches: one extraction call,
  one verification call, arbitration only for flagged pairs.
- **Multi-backend graph-database abstraction** — driver divergence tax with no v1
  benefit. Cogeto: Postgres + Qdrant, one adapter each.
- **Full graph modeling (entities as nodes, facts as edges, community detection,
  graph-distance reranking)** — powerful for multi-hop reasoning, unjustified for
  "what did I promise whom." Cogeto keeps entities as extracted references on fact
  rows (trigram-matchable, §A.5), not as a graph.
- **Unbounded invalidated-history retention with no archival story** — fine for a
  developer tool; a privacy product must pair "never destroy on supersession" with
  "truly destroy on user deletion," which is exactly the saga/receipt split.

## Application to Cogeto — summary

| Pattern | Cogeto realization |
|---|---|
| Bi-temporal (event vs ingestion time) | `valid_from`/`valid_until` + `created_at` + transition audit (migration 0001) |
| Invalidate, never delete on learning | interval close + `replaced`/`outdated`; deletion saga is separate |
| Duplicate vs contradiction candidate sets | reconciliation's two-list arbitration; material-difference rule |
| Interval arithmetic before model calls | pure-function supersession logic, property-tested |
| Point-in-time WHERE clause | temporal retrieval (§A.5) + indexed interval bounds |
| Reference-time resolution at extraction | source timestamp injected into every extraction job |
| Source episodes + provenance refs | NOT NULL `source_type`/`source_id`; cascade = provenance lookup |
| (refused) per-item LLM call fan-out, graph backends, communities | batch calls; Postgres+Qdrant; no graph in v1 |

One-line takeaway: statuses tell you *what to think* of a fact; intervals tell you
*when it was true*; the deletion saga tells you *it can still truly disappear*.
The studied system proves the first two compose; Cogeto adds the third.
