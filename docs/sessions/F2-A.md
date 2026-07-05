# Session F2-A — the reconciliation engine (pipeline stage 6)

**Date:** 2026-07-05 · **Decision record:** 0010 · **Migration:** 0011
(`fact_kind` enum + `memory.kind`; `memory_relation` + its enums and
canonical-pair tombstone index). Stage 6 is real: the `reconcileStub` is
deleted, `contradicted` is reachable at runtime (closes audit findings 1.2 and
1.7), and dedup/contradiction are measured eval tasks (closes 4.4's
reconciliation half). Dreaming, the digest, verification/v0003, and the CI
gates are F2-B.

## Frozen rulings recap (full text: decisions/0010)

1. **One engine, two drivers.** `ReconciliationService` (ingestion) is called
   incrementally by pipeline stage 6 — inside the job's idempotency
   transaction, where the incoming rows are visible only through `tx` — and in
   batch by F2-B's dreaming cycle. It owns no tables; every state change goes
   through the Memory aggregate (`MemoryReconciliation` in the memory module).
2. **`memory_relation`** (a = incoming/newer, b = existing) records kind
   (`contradicts`), prior statuses for dismiss-restoration, detected/resolved
   timestamps and the resolution. Any row — resolved or not — is a permanent
   tombstone: the pair is never re-detected; **dismissed stays dismissed**.
   Supersession stays on `superseded_by`.
3. **Resolutions** (owner-only, one transaction, fully audited):
   *confirm X* → X `contradicted → user_approved` (matrix extended: approval
   is a review verdict from `uncertain` OR `contradicted`); the loser →
   `outdated` when its own interval closed before the confirmed fact began,
   else `replaced` with `superseded_by = X`. *Correct both* → two
   edit-as-supersessions (0006 r3) + relation `corrected`. *Dismiss* → both
   parties still `contradicted` restored to recorded priors, relation
   `dismissed`.
4. **Merge policy** (`same_fact` only): survivor = newer by `created_at`,
   EXCEPT older survives when user_approved or when the newer ranks below it
   (user_approved > active > uncertain); both user_approved → no merge. Loser
   → `replaced` pointing at the survivor, interval closed. Enrichment: the
   dedup prompt's optional `merged_content` (biased hard to null) supersedes
   the survivor only when content genuinely changes and the survivor is not
   user_approved.
5. **user_approved shield:** reconciliation never touches a user_approved
   memory except to pair it into a contradiction (prior status recorded, so
   resolution restores or confirms it). Supersedes verdicts involving one
   route to contradiction.
6. **Candidate generation** — deterministic, zero model calls, thresholds in
   `reconcile-config.ts` v1: dedup = normalized similarity ≥ 0.93 OR entity
   overlap ≥ 0.8 + kind match (statuses active/user_approved/uncertain);
   contradiction = shared subject + kinds ∈ {fact, decision, preference,
   commitment} + similarity ∈ [0.80, 0.93) (statuses active/user_approved;
   incoming must be active). **Escalation:** an above-threshold pair the dedup
   model rules `distinct` becomes contradiction-eligible — otherwise
   near-identical contradictions ("October 1" vs "September 1") would be
   invisible. ≤ 3 model checks per family per fact; one contradiction action
   per fact per run. Same owner, same scope, sensitive gate respected,
   same-source rows excluded.
7. **Direction guard:** supersession applies only when the model's winner is
   also temporally later (`valid_from ?? created_at`) and neither party is
   user_approved; everything else routes to the human.
8. **Deletion interplay** (extends 0008 r5): the saga lifts unresolved
   contradictions whose evidence it deletes — surviving partners restore to
   their recorded priors (`memory.contradiction_lifted`); relation rows
   CASCADE with the deleted memory.

## What shipped

- Prompts `reconcile_dedup/v0001` and `reconcile_contradiction/v0001` (cost
  tables in-prompt: "same_fact loses every tie"; "hesitation resolves to
  compatible"; supersedes needs explicit update evidence), Zod-validated at
  the gateway, registered at worker boot, changelogged.
- Memory aggregate additions: `MemoryReconciliation` (mergeSameFact /
  createContradiction / applySupersession / listOpenContradictions /
  resolveContradiction), `restoreFromContradiction` +
  `liftContradictionsBeforeDeletion` (saga hook), tx-composable
  `transitionInTx` / `supersedeInTx` / `editContentInTx`, pure policy in
  `domain/reconcile-policy.ts`.
- Review is tabbed: **Uncertain | Contradicted**. Each contradiction shows
  both facts and both sources side by side (cited spans highlighted), with
  plain-language actions: "The newer/earlier fact is right", "Correct both",
  "Not a conflict". Nav badge = uncertain + open contradictions. The memory
  drawer gained a Contradiction panel (the chat warning chip now opens
  both-facts/both-sources context — it previously showed only its own source;
  fixed) with a "Resolve in Review" link.
- API: `GET /api/relations`, `POST /api/relations/:id/resolve` (Zod
  discriminated union).
- Eval: pair-case format (`pair.json`; extraction loader skips those dirs),
  14 pairs (7 dedup / 7 contradiction, en+hr, 3 false-merge traps, 2
  compatible traps, 1 supersedes), scored through the REAL decision path
  (`ReconcileJudge` + the same candidate functions stage 6 uses). Printed by
  `npm run eval` and appended to docs/eval/history.md.

## Eval baseline (2026-07-05, live — reconcile-config v1, prompt v0001s)

| set | dedup pairs | dedup accuracy | contra precision | contra recall | supersedes | candidate misses |
|---|---|---|---|---|---|---|
| en | 4 | 100.0% (6/6) | 66.7% (2/3) | 100.0% (2/2) | 0/1 | 0 |
| hr | 3 | 75.0% (3/4) | 100.0% (2/2) | 100.0% (2/2) | — | 0 |
| aggregate | 7 | **90.0% (9/10)** | **80.0% (4/5)** | **100.0% (4/4)** | 0/1 | 0 |

Reading: **zero false merges** (all three traps held) and **zero candidate
misses** (the escalation rule caught the near-identical go-live pair). The two
imperfections are both the conservative failure mode by design: hr-r002 (a
same_fact pair where one side adds a time) was left unmerged — a harmless
duplicate; en-r008 (supersedes) was routed to the contradiction queue instead
of silently superseding — the human decides. Dedup accuracy 90.0% meets the
§B.4 launch gate (≥ 0.90); contradiction recall 100% clears ≥ 0.70. Gates turn
ON in F2-B. Same run: extraction unchanged, verification agreement 100% en AND
hr (the hr 57.1% problem queued for v0003 did not reproduce on this run —
re-measure before/after v0003 in F2-B).

## Tests (all green; suite 85 passed, 1 live-skipped)

`stage6_idempotent`, `dedup_conservative` (distinct/related no-ops; merge +
history; user_approved override; enrichment successor with entity union),
`contradiction_marks_both` (prior statuses recorded, tombstone),
`resolution_flows` (confirm→replaced, confirm→outdated, correct, dismiss +
tombstone + idempotent re-resolve), `user_approved_shielded`,
`supersedes_direction_guard` — in `ingestion/reconcile.integration.spec.ts`
(real Postgres + Qdrant, judge scripted at the gateway seam), plus
`memory/domain/reconcile-policy.spec.ts` (pure rules) and the updated
transition matrix (22 legal transitions; +1 for contradicted→user_approved).
Lint, boundaries (189 modules, 0 violations), build green; compose up reaches
login (200), health all-ok, migration 0011 applied, all four prompt families
registered.

## Known limits (deliberate, for F2-B or later)

- Distinct/compatible verdicts are not persisted; the dreaming batch driver
  adds a checked-pair ledger if nightly re-asking proves wasteful (0010 r7).
- An uncertain fact never enters contradiction checking; once approved, only
  the batch driver revisits it — incremental stage 6 has moved on.
- The drawer's contradiction panel resolves the partner client-side from
  `GET /api/relations` (fine at single-tenant volume).
- `entitySearch`'s statuses filter is applied app-side on non-gate fields for
  the entity candidate path; scope/sensitive stay in-query as always.
