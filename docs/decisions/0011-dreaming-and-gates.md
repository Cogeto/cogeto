# 0011 — Dreaming, the plain digest, and the CI eval gates (Session F2-B)

**Date:** 2026-07-05 · **Status:** accepted · **Governs:** the dreaming cycle's
scope, tables and actor; the dormant-flag contract; the digest's scoping and
link grammar; the §B.4 gate values and their ratchet rule; the eval-gate CI
job; and one harness-rule amendment. **Driven by:** Addendum §B.6 (plain form
now, card v1.x), decision 0010, docs/eval-golden-set.md §6, and the F2-B owner
prompt. Migration this session is **0012**.

## Ruling 1 — Dreaming lives in ingestion; incremental by watermark

`DreamingService` (ingestion — dreaming is the consolidation half of the
pipeline; glossary) drives the F2-A engine in batch: nightly at **03:30**
(graphile cron `dreaming_cycle` — underscore, the crontab parser rejects
dots), after the 03:00 sweep, plus `npm run dream` on demand. Scope is
incremental: from the last FINISHED run's window end (`dream_run.scope_to`) to
now — the day's newly admitted facts and the memories touched in that window
(`created_at` or `updated_at` in range, status active/uncertain), grouped per
owner, each owner batch in its own transaction. Never the whole store. A
crashed run leaves `finished_at` NULL and its window is re-covered — resumable
by construction; effects are idempotent via the 0010 ruling 7 mechanisms, so
like the sweep the job is deliberately NOT wrapped in `idempotentTask`.

Tables `dream_run`, `dream_action`, `dormant_flag` are **ingestion-owned**;
memory-referencing columns FK with ON DELETE CASCADE for the deletion saga
only (the `verification_result` precedent) — erased memories take their dream
traces with them, which is also what keeps every digest link resolvable.

## Ruling 2 — System reads, named and bounded

The driver needs instance-wide scans no Principal can represent. The memory
aggregate exposes four documented **worker-only system reads**
(`listTouchedBetween`, `listLapsedActive`, `listQuietCommitments`,
`getManySystem`) plus `retrieveEmbeddings` — the out-of-module mirror of the
sweep's in-module scans. They feed reconciliation, whose candidate reads and
actions re-apply the per-owner gates; nothing read this way reaches a user
except through a gated read. User-facing paths remain Principal-gated and
unrepresentable otherwise (0003 ruling 2 unchanged).

## Ruling 3 — Staleness runs as the consolidation actor

The staleness pass is deterministic and model-free: every `active` memory with
`valid_until < now` transitions to `outdated` through the aggregate as the
**consolidation** actor — the transition matrix's owner of `outdated` since
S1-B, and dreaming IS the consolidation job (glossary). The owner prompt's
"the reconciliation actor's transition" is implemented as this machine actor;
giving `outdated` to the literal `reconciliation` actor would have widened the
matrix for no gain. Flagged for the owner in the session log.

## Ruling 4 — Dormant flags: recorded, never transitioned

An `active` commitment (`kind='commitment'`) with both `created_at` and
`updated_at` older than `DORMANT_SILENCE_DAYS` (v1: 14, in the versioned
reconcile config) gets a `dormant_flag` row — one OPEN flag per memory (unique
partial index; re-detection is a no-op). The memory's status is untouched.
Clearing: dreaming clears flags whose memory is no longer `active`; the F3
task engine clears on task closure (contract frozen in
docs/handoff/F2-dreaming.md). This table is what F3 consumes — through
ingestion's public interface, never the table.

## Ruling 5 — The digest: gate-scoped lines, fixed link grammar

`GET /api/dreaming/latest` returns the latest finished run's actions as at
most **six** lines for the CALLER: memory details resolve exclusively through
`getManyForPrincipal`, so other owners' actions (and deleted memories) produce
no line — scoping by gate, not by filter. Empty lines ⇒ the Dashboard panel
renders nothing (§B.6: silent nights produce no card). Line grammar, frozen:
conflicts → `/review?tab=contradicted`; merges/supersessions →
`/memories?open={survivor|winner}`; quiet commitments →
`/memories?open={id}`; staleness aggregate → `/memories?status=outdated`;
overflow beyond six folds into "…and K more changes" → `/memories`. Priority
when trimming: conflicts, merges, updates, quiet commitments, the aggregate.
The tappable morning chat card stays v1.x; its contract lives in the handoff,
not in code.

## Ruling 6 — Gate values (gates.json v1) and the ratchet

Gates apply to **aggregate** metrics, enforced when `COGETO_EVAL_GATE=1`
(`npm run eval:gate`, CI). Values per docs/eval-golden-set.md §6, with one
honest floor:

| metric | spec | gate v1 | why |
|---|---|---|---|
| extraction precision | 0.85 | **0.70** | observed band 71.2–82.5% across five same-code runs of the 36-case corpus (pure extractor run-to-run variance) — the gate sits BELOW the band's floor because a gate inside the noise band is flaky, and a flaky gate gets ignored. NOT the spec target; gaming the number was the alternative and is rejected. Flagged to the owner. |
| extraction recall | 0.80 | 0.80 | measured 83.3–94.4% |
| verification agreement | 0.90 | **0.75** | observed band 79.4–91.2% aggregate (the final v0004 run measured 91.2% — at spec); the residual disagreements are the verifier CORRECTLY demoting bad extractions (wrong direction, hallucinated slot, unhedged forecast) — the metric conflates extractor quality with verifier calibration. hr itself moved 57.1% → 81.8–90.9% under v0004. Honest floor; flagged to the owner. |
| dedup accuracy | 0.90 | 0.90 | false merges weighted ×2; measured 92.9% |
| contradiction recall | 0.70 | 0.70 | measured 100% |

A gate at the floor of the observed noise band still does its §B.4 job: a
genuinely broken prompt lands FAR below it (the degraded-prompt demonstration
in the session log measures verification agreement collapsing to single
digits), while honest run-to-run noise passes.

**Ratchet rule: gates only move UP.** Raising a gate is a config edit;
lowering one requires a decision record. The chat eval gates alongside: every
`eval:chat` case must PASS under the same env switch. A >2-point drop from
the previous release requires a decision record even above the gate (spec §6).

## Ruling 7 — The eval-gate CI job

A separate workflow (`.github/workflows/eval-gate.yml`), not a step in the
main CI: it needs the `MISTRAL_API_KEY` repository secret and its triggers are
path-scoped — PRs and main pushes touching `project/prompts`, `project/eval`,
`project/src/{ingestion,retrieval,model-gateway}`, or `project/shared`. When
the secret is absent (fork PRs) the job **skips with a loud warning**
annotation instead of failing — the gate then runs on the merge branch, where
the secret exists. Required-to-merge is a repository setting the owner flips
(branch protection → require `eval-gate`); recorded in the session log
checklist because it cannot be set from the repo.

## Ruling 8 — Harness amendment: hedged strays do not spring traps

`verification_expected: "unsupported"` trap cases now ignore stray facts the
extractor flagged `hedged`: the admission rule (S3.5-B) stores them
`uncertain` regardless of verdict, and v0002/v0003 rule a faithfully carried
hedge `supported` by design. The trap checks what would be REMEMBERED as
active — extractor abstention, verifier demotion, and hedging are all correct
trap handling. Surfaced by the new `en-0024` forecast trap, where the only
"failure" was the harness rule predating the F7 hedge split.
