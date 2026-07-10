# Session QS-B — Deletion/ingestion correctness (QS-5, QS-37, QS-26)

**Model:** Fable 5. **Implements:** the audit's QS-B cluster
(`docs/audits/quality-security-audit.md`) — the three findings that break the
product's central guarantee from the storage side: the delete-vs-ingestion
race (QS-5), provenance integrity as constraint-not-convention (QS-37), and
the vector-store optionality asymmetry (QS-26). **Decision:** `0024`
(provenance-integrity enforcement — mechanism choice + rejected alternatives).
**No migration** (schema untouched; migrations stay at 0019). **No new
dependency.**

## The race, stated precisely (QS-5)

The pipeline job holds ONE Postgres transaction across its model calls
(5–30 s). Its old shape: claim idempotency row → `load()` the source (no lock,
on `this.db`) → extract/verify (slow) → insert memory rows + Qdrant points →
commit. The saga's old shape: enumerate memories `FOR UPDATE` → lock source →
delete rows + source → receipt `pending` → commit. Nothing serialized the two,
so this interleaving was fatal:

```
pipeline: load(note) ok ──── model calls (30 s) ──────────► insert rows ► commit
saga:            lock note ► enumerate (0 rows!) ► delete note ► receipt(0) ► commit
result:   memory rows + points whose provenance points at a deleted note,
          covered by NO receipt, invisible to the sweep (it only re-checks
          receipt-enumerated ids). Provable forgetting broken.
```

## The fix — both sides, and why either alone is insufficient

### Mechanisms added

1. **Run lock (infrastructure):** `idempotentTask` now takes a
   transaction-scoped advisory lock keyed
   `(job_type, source_type, source_id)` **before** inserting its idempotency
   row; `pipeline.run` re-acquires it (reentrant) so direct callers (tests,
   eval) are covered too. Holding it = "a run of this key is in flight."
2. **Saga-side cancellation:** in `requestSourceDeletion`, inside the
   enumeration transaction, **after locking the source row and before
   enumerating memories**, the saga calls the new `IngestionGuard` port
   (memory defines, ingestion implements — `PipelineIngestionGuard`; bound as
   a REQUIRED `MemoryModuleOptions` field in both composition roots):
   - probe the run lock (non-blocking). Free → insert the
     `(source_type, source_id, 'ingestion.pipeline')` `job_execution` row
     (`consumeIdempotencyKey`) → any queued/future delivery skips at its
     claim, before ever loading the source → `cancelled`.
   - key already present → ingestion finished long ago → `already_ran`.
   - probe fails (run in flight) → `run_in_flight`; rely on the admission
     checkpoint (below) — EXCEPT discard-mode files (`file` + no
     `file_metadata` row), where there is no row to serialize on: there the
     guard **blocks on the run lock** until the run finishes, then consumes
     the key, and the saga's enumeration sees everything the run committed.
   - The outcome is recorded in the `source.deletion_requested` audit detail
     (`ingestionCancellation`).
3. **Pipeline-side admission checkpoint:** `SourceReader.existsForAdmission
   (tx, sourceId)` — a `FOR KEY SHARE` existence check on the durable source
   row (note / user chat message / `file_metadata`), executed in the SAME
   transaction that inserts memories, after the slow stages, immediately
   before stage 5. Source gone → abort admission cleanly: zero rows, zero
   points, `summary.skipped = 'source_deleted'`, audit row
   `ingestion.admission_aborted`, job completes consuming its key. Skipped
   only for discard-mode sources (`stagingKey` set — no durable row by
   design; covered by mechanism 2's waiting branch).
4. **Sweep orphan arm (detector + historical residue):** see QS-37 below.

### Interleaving analysis (the full case split)

Notation: `P` = pipeline transaction, `S` = saga enumeration transaction, for
the same source. `K` = the ingestion idempotency key, `RL` = the advisory run
lock, `src` = the durable source row.

- **P commits before S starts.** S's probe finds RL free, `consumeIdempotencyKey`
  no-ops on the committed K (`already_ran`); enumeration sees all of P's rows;
  the receipt covers them. Honest.
- **S commits before P starts (queued job).** S found RL free and consumed K.
  P's claim insert conflicts → skip before `load()`. Zero work, zero rows.
  (Pre-fix this case was *mostly* safe for row-backed sources — `load()`
  returned null — but NOT for discard files, whose staging object still
  yields content; the key cancellation closes that.)
- **P in flight when S runs (the audit's window), row-backed source.** S locks
  `src FOR UPDATE` (free — P holds no row lock during model stages), probe
  fails (`run_in_flight`), S enumerates (misses P's uncommitted rows — by
  design), deletes rows + `src`, receipt, **commits without waiting**. P
  reaches the checkpoint: `KEY SHARE` on `src` → row deleted → abort as no-op.
  Nothing was admitted; the receipt honestly says what existed. **This is the
  tested path.**
- **Same, but P's checkpoint wins the lock race.** P's `KEY SHARE` acquires
  before S's `FOR UPDATE`; the lock is held until P commits; S blocks at its
  FIRST statement (source lock) holding nothing → no deadlock; then S
  enumerates AFTER P's commit and erases P's fresh rows under the receipt.
  Honest (equivalent to "P commits before S").
- **S and P start simultaneously.** P's claim insert and S's consume-insert
  can only conflict when one is uncommitted — and the run-lock ordering makes
  that impossible: P takes RL *before* its claim, so if S's probe succeeded, P
  hasn't inserted yet and will block/skip on RL→K after S; if S's probe
  failed, S never inserts. The unique index is never a blocking point for S.
- **Discard-mode file, queued job.** No row anywhere; `load()` would read the
  staging object and ingest a deleted source. S's probe free → K consumed →
  job skips at claim. Closed.
- **Discard-mode file, in-flight run.** S has nothing to lock; the checkpoint
  is skipped by design. S's guard **waits on RL** (S holds no row locks while
  waiting — `file_metadata FOR UPDATE` on an absent row locks nothing → no
  deadlock), the run commits its memories + its K, S then consumes nothing new
  (`already_ran`), enumerates the fresh rows, erases them under the receipt.
  The DELETE request blocks for the remaining model-call time in this one
  rare shape — the price of correctness where no row exists to serialize on.
- **P aborts/retries around any of the above.** A rolled-back claim releases
  K and RL; a retry after S committed finds K consumed (skip) or the source
  gone at `load()`/checkpoint (no-op). A retry after S *aborted* proceeds as
  a normal ingestion — the source still exists. All convergent.
- **Deadlock audit.** Lock order is consistent where it matters: S takes
  `src → RL-probe/K → memory rows`; P takes `RL → K → src(KEY SHARE) →
  memory rows`. S never *waits* on RL or K while holding row locks that P
  wants before its own RL/K (P acquires those first, at transaction start,
  before any lock S could hold matters); the probe is non-blocking; the
  waiting branch holds no row locks. Residual (pre-existing, unchanged):
  P's *reconcile* stage and S's enumeration can still ABBA on two **memory**
  rows through a supersession/contradiction web — Postgres detects, kills
  one, and both retry paths converge to an honest state (graphile backoff /
  user retry). Not introduced by this change and not fixable without
  serializing all reconciliation against all deletion.
- **Deletion-before-extraction of a discard upload** (pre-existing 404
  contract, unchanged): a discard-mode source with no memories yet 404s on
  delete (nothing to authorize against, nothing enumerable). With this fix
  the 404 rolls back the key consumption — but the ONLY way memories can
  later appear is the queued job, and deleting *after* they appear works
  normally. Documented as a known, honest edge: the upload's staging backstop
  still erases the bytes.

### Race test — red first, then green

`project/src/memory/deletion-race.integration.spec.ts` — real Postgres +
Qdrant + graphile worker + real `NotesService`/saga/pipeline; the gateway mock
**parks inside extraction on a controllable promise** (the audit's 5–30 s
window made deterministic). The test deletes the note mid-extraction (the
call completing while the gate is still closed also proves deletion does not
block), releases extraction, drains the worker, and asserts: zero memory
rows, zero Qdrant points, receipt `confirmed` with `memory_count: 0` and a
signature, idempotency key consumed (no-op completion), empty queue, no
dead-letter, `ingestion.admission_aborted` audit row,
`ingestionCancellation: 'run_in_flight'` in the saga's audit detail, and a
clean sweep.

**Red run (fix disabled):** with the admission checkpoint and the guard
call temporarily neutralized (the pre-fix code shape), the same test fails
exactly as the audit predicted:

```
FAIL  deletion_mid_extraction …
AssertionError: expected 1 to be +0   // memoryCount(note.id) after deletion
```

**Green run (fix enabled):** `3 passed (3)` — including
`deletion_before_job_starts` (queued-job cancellation via the consumed key,
`ingestionCancellation: 'cancelled'`) and `orphan_sweep_arm` (below).

## QS-37 — provenance integrity (decision 0024)

Chosen mechanism: **mandatory app-level admission checkpoint + saga-side
cancellation as prevention, sweep as detection** — per-type FKs and an insert
trigger are rejected in `0024` (polymorphic provenance + discard-mode
sources, which legitimately have NO durable row, make both unsound; the FK
variant is also a frozen-§A.6 schema break). The bar — *an insert referencing
a nonexistent source must be impossible or detected within one sweep cycle* —
is met: every extracted-fact admission path runs the checkpoint inside its
writing transaction, and the sweep's new `orphaned_memory` arm detects
anything that slips past any future path:

- **Receipt-side detector** (all source types, discard files included): any
  memory whose `(source_type, source_id)` matches a confirmed receipt but
  whose id is not in it is a post-receipt resurrection.
- **Source-side detector** (adapter-backed types): distinct provenance groups
  probed through the same `SourceDeletion` adapters the saga uses
  (`ownerOf === null` = row gone), with a same-transaction re-read of the
  memories on a miss so the saga's atomic delete can never yield a false
  positive mid-flight. Catches historical residue from before this session.

Alerts are persistent, deduped (`integrity_alert` unique index), never
auto-repaired, and surface in `/api/health` + the System view — same contract
as every other sweep arm. The saga's delete ordering is untouched. The
on-demand `npm run sweep` entrypoint now binds the notes + chat adapters.

## QS-26 — vector-store optionality asymmetry

- `transitionInTx` and `supersedeCore` now call `requireVectors()` exactly
  like the sensitive/scope toggles — a store wired without Qdrant **throws**
  on any status transition or supersession instead of leaving the point's
  payload stale (`active` in Qdrant, `contradicted`/`replaced` in Postgres).
- Boot assertions: `MemoryModule.register` refuses a missing `qdrantUrl`;
  `createMemoryStore`/`createMemoryReconciliation` refuse to build a
  vector-less store unless the caller passes an explicit `sqlOnly: true`,
  reserved for test/fixture paths that exercise no vector-dependent
  operation (each remaining site is marked and justified in place).
- Regression test `vectorless_transition_throws`
  (memory.integration.spec.ts): transition AND supersession on a vector-less
  store reject with the `requireVectors` error and leave the row untouched.
- Collateral (necessary, and it closes part of the audit's QS-30 gap): the
  memory, approvals and tasks integration suites now run against a real test
  Qdrant, because their transition/edit paths genuinely require one.

## Files touched

Infrastructure: `queue.ts` (+`acquireJobRunLock`/`tryJobRunLock`/
`consumeIdempotencyKey`; run lock in `idempotentTask`), `index.ts`.
Ingestion: `pipeline/source-reader.ts` (port +`existsForAdmission`),
`pipeline/pipeline.service.ts` (run lock + admission checkpoint + `skipped:
'source_deleted'`), `pipeline/pipeline-guard.ts` (new), `index.ts`.
Memory: `deletion-saga.ts` (IngestionGuard port; lock-ordered
`requestSourceDeletion`; split `resolveSource`/`enumerateAndAuthorize`; audit
detail), `integrity-sweep.ts` (orphan arms + adapters), `memory.store.ts`
(QS-26), `factory.ts` (sqlOnly guard; sweep adapters), `memory.module.ts`
(required `ingestionGuard`; qdrantUrl assertion), `file-store.ts`
(`existsForAdmission`), `index.ts`, `deletion-race.integration.spec.ts`
(new), `memory.integration.spec.ts` (Qdrant + regression test).
Connectors/retrieval: `notes.source-reader.ts`, `file.source-reader.ts`,
`chat/chat.source-reader.ts` (checkpoint impls). Entrypoints: both
composition roots (guard binding), `sweep.ts` (adapters), `seed-object.ts`
(sqlOnly). Tests: `pipeline.integration.spec.ts` (FakeReader),
`approvals.integration.spec.ts` + `tasks.integration.spec.ts` (real Qdrant),
`tasks-digest.integration.spec.ts` (sqlOnly). Docs: decision `0024`, audit
RESOLVED lines, this log.

## Verification (definition of done)

- Full Vitest suite, lint (`eslint` + `prettier --check`), module boundaries
  (`depcruise`), `tsc` build: green (outputs in session transcript).
- `docker compose up` reaches login on the compose stack (compose-to-login
  re-verified after the change; no compose/infra files touched).
- Binding invariant tests: deletion-cascade, scope-leak, approval-gate suites
  all green; the golden-set eval gate is untriggered (no prompt or model
  change) and the eval harness code is untouched.

## Manual reproduction (for the owner)

1. `docker compose up`, log in, capture a note with a durable fact.
2. Within the extraction window (worker logs show the pipeline job start;
   Mistral latency gives seconds), delete the note's source from the
   dashboard (or `DELETE /api/sources/user_note/:id`).
3. Before: seconds later the memory appears anyway, with a confirmed receipt
   claiming 0 memories — and `npm run sweep` stays green (the lie).
   After: no memory ever appears; `/api/audit` shows
   `ingestion.admission_aborted` (or the receipt's detail shows
   `ingestionCancellation: 'cancelled'` if the job hadn't started); the
   receipt is honest; `npm run sweep` stays green because nothing survived.
4. Orphan detector: insert a memory row with a bogus `source_id` directly in
   SQL (simulating a restored backup), run `npm run sweep` → exit 1 with an
   `orphaned_memory` alert naming the row; visible in the System view.
