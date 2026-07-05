# 0010 — Reconciliation rulings (Session F2-A)

**Date:** 2026-07-05 · **Status:** accepted · **Governs:** the reconciliation
engine (pipeline stage 6, glossary *Reconciliation*): service placement, the
`memory_relation` table, contradiction resolution semantics, the merge policy,
the `user_approved` shield, candidate generation, and idempotency.
**Driven by:** Addendum §B.2/§B.3, audit findings 1.2/1.7/4.4, research
memory-architecture §§1, 3, 7, and the F2-A owner prompt. Design choices the
prompt delegated are frozen here — they are decisions, not proposals.
Migration this session is **0011**.

Calibration stance, binding on every ruling below: **a wrong merge destroys a
distinct fact, a wrong contradiction wastes the user's attention, and both are
worse than doing nothing.** Where a rule had a lenient and a conservative
reading, the conservative one was frozen.

## Ruling 1 — One reconciliation service, two drivers; relations live in memory

The engine is ONE service (`ReconciliationService`, ingestion module — stage 6
is ingestion's stage) invoked from two drivers: incrementally as pipeline
stage 6 (the new facts of one source vs the existing committed memory of the
same owner and scope) and in batch by the nightly dreaming cycle (F2-B). Same
code, two drivers; the service takes `(tx, items)` so both run inside their
job's idempotency transaction.

The service owns **no tables** and performs **every state change through the
Memory aggregate's public interface** (mergeInto, createContradiction,
applySupersession — new in this session). The `memory_relation` table is a
**memory-module** table: relations pair memory rows and drive status
invariants, which the aggregate owns (§A.1 rule 4). Candidate reads go through
the existing Principal-gated search primitives (0003 ruling 2) with the owner
as principal.

*Rationale:* the aggregate stays the single writer of memory state; the model
judgment (ingestion) and the state machine (memory) separate cleanly, and the
F2-B batch driver reuses the service verbatim.

## Ruling 2 — `memory_relation`: shape, tombstone semantics

Migration 0011: `memory_relation (id, kind memory_relation_kind — enum starting
with 'contradicts', a_memory_id, b_memory_id — both FK memory ON DELETE
CASCADE, a_prior_status, b_prior_status — memory_status, detected_at,
resolved_at nullable, resolution memory_relation_resolution nullable —
'confirmed_a' | 'confirmed_b' | 'corrected' | 'dismissed')`. Convention: **a**
is the incoming (newer) fact at detection time, **b** the existing one. A
unique index on `(kind, least(a,b), greatest(a,b))` makes the pair canonical.

**Tombstone semantics:** a relation row — resolved or not — permanently
excludes its pair from re-detection. In particular, *dismissed stays
dismissed*: the user has already ruled the pair compatible and reconciliation
never asks again.

Supersession stays on `superseded_by`; the relation table is not overloaded
with it. The prior-status columns exist solely for dismiss-restoration.

Migration 0011 also adds `memory.kind fact_kind` (nullable enum: commitment,
decision, preference, fact, open_loop) — the extractor has always produced it
and stage 5 now stores it; candidate generation needs kind match. Pre-F2 rows
have NULL kind and are conservatively excluded from the kind-gated candidate
paths.

## Ruling 3 — Contradiction resolution semantics (owner actions, Review queue)

All three resolutions are owner-only, single-transaction, audited per touched
entity, and set `resolved_at` + `resolution` on the relation.

- **Confirm A** (confirm B symmetric): the confirmed memory transitions
  `contradicted → user_approved` (the transition matrix now allows
  `user_approved` from `contradicted` for the user actor — resolution is a
  review verdict). The other memory (L, the loser):
  - **time-superseded** — L's own interval had already closed before the
    confirmed fact began (`L.valid_until` is set and ≤ the confirmed fact's
    `valid_from ?? created_at`): L → `outdated`. It was true and expired on
    its own; nothing replaced it.
  - **directly corrected** — every other case: L → `replaced` with
    `superseded_by = confirmed id` and `valid_until` closed at the confirmed
    fact's `valid_from ?? resolution time`. §B.2 mechanics, pointing at the
    existing winner (no new row).
- **Correct both:** routes to the existing edit-as-supersession flow
  (0006 ruling 3) per memory: the resolution call carries new content for both;
  each memory is superseded by a `user_approved` successor in the same
  transaction; the relation resolves `corrected`.
- **Dismiss:** relation resolves `dismissed`; each memory still in
  `contradicted` is restored to the prior status recorded at detection. A
  memory the user already moved by other means (e.g. edited meanwhile — now
  `replaced`) is left untouched; `replaced` is terminal.

## Ruling 4 — Merge policy (dedup verdict `same_fact` only)

- `distinct` and `related` verdicts change **nothing**. Only `same_fact`
  merges.
- **Survivor selection:** the newer memory (by `created_at`) survives, EXCEPT:
  1. the older is `user_approved` → the older survives (user judgment
     outranks recency);
  2. the newer ranks strictly below the older on the confidence scale
     `user_approved > active > uncertain` → the older survives (a verified
     fact never yields to an unverified duplicate of itself);
  3. both are `user_approved` → **no merge at all** (only the user resolves
     against their own confirmations — ruling 5).
- **Merge mechanics:** the loser → `replaced`, `superseded_by = survivor`,
  `valid_until` closed at the survivor's `valid_from ?? merge time`. History
  preserved; no row is ever deleted. Audit `memory.merged`.
- **Enrichment:** the dedup prompt may return `merged_content` alongside
  `same_fact` — the survivor's claim enriched with a *concrete, fact-bearing*
  detail only the loser carried (a date, amount, name, condition); it is
  instructed to return null in every other case. Enrichment applies ONLY when
  `merged_content` is present, differs from the survivor's content after
  whitespace normalization, and the survivor is **not** `user_approved`
  (ruling 5). Then the survivor is superseded (§B.2: new row, survivor's
  provenance and status, entity union of both parties) by the enriched
  successor, and the loser's pointer targets that successor. When content is
  identical or the model returns null, content is untouched — the merge is the
  pointer alone.

## Ruling 5 — The `user_approved` shield

Reconciliation (both drivers, all verdicts) never transitions, supersedes,
merges, or enriches a memory whose status is `user_approved`, with exactly one
exception: **pairing it into a `contradicts` relation**, which transitions it
to `contradicted` with its prior status recorded so resolution can restore or
confirm it. Consequences, frozen:

- `same_fact` where the would-be loser is `user_approved` → no action.
- `supersedes` where either party is `user_approved` → routed to contradiction
  (the user decides).
- Enrichment never supersedes a `user_approved` survivor.

## Ruling 6 — Candidate generation: deterministic, cheap, model-free

Per new fact, candidates come from committed memory of the **same owner and
same scope**, via the gated primitives with the owner as principal; the
`sensitive` gate is respected — a non-sensitive incoming fact never pairs
against sensitive rows (pipeline facts are never sensitive in v1). Rows from
the same source as the incoming fact are excluded (within-batch dedup is not
reconciliation's job — research §3 tier 1). All thresholds live in ONE
versioned config, `project/src/ingestion/reconcile-config.ts` (v1):

- **Dedup candidates** (existing status `active`, `user_approved`, or
  `uncertain`): normalized embedding similarity ≥ `dedupSimilarity` (v1:
  0.93) **OR** — entity overlap `|A∩B| / min(|A|,|B|)` ≥ `entityOverlapMin`
  (v1: 0.8, case-insensitive exact names, both sets non-empty) AND identical
  `kind`.
- **Contradiction candidates** (existing status `active` or `user_approved`;
  the incoming fact must itself be `active` — `uncertain` noise never earns a
  warning chip; once approved, the F2-B batch driver revisits it): equal
  `subject_entity` (case-insensitive, both non-null) AND both kinds ∈ {fact,
  decision, preference, commitment} AND similarity in the mid band
  [`contradictionBandLow`, `dedupSimilarity`) (v1: [0.80, 0.93) — similar
  topic, different content). **Escalation:** a pair ABOVE the dedup threshold
  that the dedup model ruled `distinct` is also contradiction-eligible —
  "go-live October 1" vs "go-live September 1" embeds nearly identically, and
  same-slot-different-value is exactly what the `distinct` verdict flags;
  without escalation, high-similarity contradictions would be structurally
  invisible. `related` verdicts do NOT escalate (not cleanly comparable —
  conservative).
- At most `maxChecksPerFact` (v1: 3) model confirmations per family per fact,
  best-similarity first; the first `same_fact` merge wins and stops that
  fact's processing; at most ONE contradiction action per fact per run.
- No model calls anywhere in candidate generation.

## Ruling 7 — Acting on verdicts: direction guard and idempotency

- `supersedes` (from the contradiction prompt) applies the existing
  supersession mechanics (close interval, `replaced`, pointer at the existing
  winner) ONLY when the direction is unambiguous — the model's winner is also
  the temporally later memory (`valid_from ?? created_at`) — and neither party
  is `user_approved`. Any disagreement between model direction and event order
  routes to contradiction instead. Never silent supersession on doubt.
- Idempotency under re-delivery, by construction: relation tombstones (ruling
  2) block re-pairing; merged/superseded losers become `replaced` and leave
  every candidate pool; a re-run skips incoming facts no longer
  `active`/`uncertain`; all aggregate actions re-check state under row locks
  and no-op when already applied. The pipeline job's §A.3 idempotency key
  guards the outer layer.
- Distinct/related and compatible verdicts are deliberately NOT persisted in
  F2-A: within one incremental run they cannot repeat, and the F2-B batch
  driver adds its own checked-pair ledger if nightly re-asking proves wasteful
  (its cost, its decision).

## Ruling 8 — Cascade interaction (extends 0008 ruling 5)

Deleting a source whose memories sit in unresolved relations: within the
saga's enumeration transaction, each surviving partner still in `contradicted`
is restored to its recorded prior status (audited,
`memory.contradiction_lifted`) before the rows are deleted; the relation rows
themselves go with the deleted memory (FK CASCADE). An accusation whose
evidence was erased does not stick — and a permanently-`contradicted` orphan
with no resolution path may not exist.

## Ruling 9 — Eval: pair cases and scoring

Reconciliation pair cases live under `project/eval/golden/{lang}/{case-dir}/`
as `pair.json` (task `dedup` | `contradiction`, facts `a`/`b` with content,
kind, entities, subject_entity, capture/validity dates, expected outcome); the
loader dispatches on file presence, so extraction cases are untouched. The
harness runs the REAL reconciliation decision path (candidate rules from the
versioned config + live model confirmation) over each pair and scores
**actions**, not verdict strings:

- **Dedup accuracy** — weighted per docs/eval-golden-set.md §5: must-not-merge
  trap pairs carry weight 2 (a false merge destroys a distinct fact); accuracy
  = earned weight / total weight.
- **Contradiction recall** = flagged true pairs / labeled `contradicts` pairs;
  **precision** = true flags / all flags (compatible traps and supersedes
  pairs flagged `contradicts` count against it). Supersedes correctness
  (verdict AND direction) reported separately.

Results print beside the extraction metrics and append to
`docs/eval/history.md`. CI gates stay off until F2-B (0005 ruling 5 chain).
