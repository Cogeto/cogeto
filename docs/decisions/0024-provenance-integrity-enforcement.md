# 0024 — Provenance integrity: app-level admission checkpoint + saga-side cancellation + sweep detection (QS-5, QS-37)

**Status:** Accepted. **Context:** the quality/security audit
(`docs/audits/quality-security-audit.md`) proved two related holes in the
product's central guarantee. **QS-5:** a source deleted while its ingestion job
is mid-flight (the pipeline holds its transaction open across 5–30 s of model
calls) resurrects memories from the "erased" source — provenance pointing at a
deleted row, covered by no receipt, invisible to the sweep. **QS-37:**
AGENTS.md's "no orphans, ever" was convention, not constraint — `memory.source_id`
is `text NOT NULL` with an index and **no FK**, because provenance is
polymorphic (`source_type` selects among `note`, `chat_message`,
`file_metadata`, and — for discard-mode uploads — *no durable row at all*).

## Decision

Enforce provenance integrity with **three cooperating mechanisms**, all
app-level plus a detector, instead of a database constraint:

1. **Admission checkpoint (pipeline side).** `SourceReader` gains
   `existsForAdmission(tx, sourceId)`: inside the pipeline's idempotency
   transaction, after the slow model stages and immediately before any memory
   row is inserted, the reader re-verifies the durable source row exists with a
   **`FOR KEY SHARE`** row lock. `KEY SHARE` conflicts with the saga's
   `FOR UPDATE`/`DELETE` but blocks nothing else. Two outcomes, both safe: the
   saga committed first → the row is gone → the pipeline aborts admission as a
   no-op (zero rows, zero points, audit trace `ingestion.admission_aborted`,
   idempotency key consumed); the checkpoint locks first → the lock is held to
   commit, the saga's enumeration waits and then sees (and erases, under the
   receipt) the fresh memories.

2. **Cancellation guard (saga side).** A fourth port of the existing family
   (`SourceReader` / `SourceDeletion` / `DerivedCascade`): memory defines
   `IngestionGuard`, ingestion implements it (`PipelineIngestionGuard` — it
   owns the job type), composition roots bind it (**required** in
   `MemoryModuleOptions`, so production wiring cannot omit it). Inside the
   enumeration transaction, after locking the source row and **before
   enumerating memories**, the saga cancels pending ingestion:
   - `idempotentTask` (and `pipeline.run` itself, for direct callers) now takes
     a **transaction-scoped advisory run lock** keyed
     `(job_type, source_type, source_id)` *before* inserting the idempotency
     row. Probe success therefore proves no run is in flight — making the
     saga's key-consuming insert non-blocking by construction.
   - No run in flight → the saga inserts the
     `(source_type, source_id, 'ingestion.pipeline')` idempotency row itself
     (`consumeIdempotencyKey`): any queued or future delivery skips at its
     claim, before ever loading the source.
   - Run in flight → row-backed sources rely on mechanism 1 (the source-row
     lock the saga already holds serializes the run's checkpoint);
     **discard-mode files** — no `file_metadata`, no row anywhere, the one
     shape mechanism 1 cannot cover — make the guard **wait** on the run lock
     until the in-flight run finishes, then consume the key and enumerate
     whatever it committed.
   The outcome (`cancelled` / `already_ran` / `run_in_flight`) is recorded in
   the deletion audit entry.

3. **Sweep detection (the QS-37 bar: "impossible, or detected within one sweep
   cycle").** The nightly integrity sweep gains an **orphan-memory arm** with
   two detectors:
   - *Receipt side* (all source types, discard files included): any memory row
     whose `(source_type, source_id)` matches a **confirmed receipt's** source
     but whose id is not in that receipt is a post-receipt resurrection.
   - *Source side* (adapter-backed types — notes, chat): memories grouped by
     provenance whose source row no longer exists, probed through the same
     `SourceDeletion` adapters the saga binds, with a same-transaction re-read
     of the memories on a miss so an in-progress atomic saga delete can never
     produce a false positive. This also catches **historical residue** from
     before this fix.
   Hits become persistent `orphaned_memory` integrity alerts (deduped,
   never auto-repaired), surfacing in `/api/health` and the System view.

## Alternatives rejected

- **Per-type foreign keys** (split provenance into `note_id` / `chat_id` /
  `file_key` columns + CHECK): the only way Postgres can express a polymorphic
  FK, but it breaks the frozen §A.6 schema (`source_type` + `source_id`, NOT
  NULL) and the F1 handoff's receipt/enumeration contract — a schema-breaking
  change to the very tables this repo commits never to break, needing owner
  sign-off for negative value: discard-mode files would *still* have no parent
  row, so the FK could never cover the one case that most needs it.
- **Insert trigger validating source existence:** duplicates every connector's
  table knowledge inside SQL (violating §A.1 module ownership in the database
  layer), must special-case `file` (discard mode has no row — the trigger
  would reject legitimate admissions or exempt exactly the unprovable case),
  and adds a per-row cross-table probe on the hottest write path. It also
  guards only INSERT — the QS-5 race would simply move to
  check-inside-trigger vs. delete-commit ordering, which is the same problem
  the KEY SHARE checkpoint solves explicitly and readably in code.
- **Blocking the saga on the in-flight run unconditionally** (consume the key
  and let the unique index serialize): correct, but the user's DELETE would
  hang for the full model-call window on every mid-flight race, and the
  saga-vs-pipeline lock ordering (`key → source row` vs `source row → key`)
  admits an ABBA deadlock. The advisory-probe design keeps deletion
  non-blocking for every row-backed source.

## Interleaving argument (summary)

The saga's lock order is `source row → run-lock probe/claim → memory rows`;
the pipeline's is `run lock → idempotency claim → (no locks during model
stages) → source KEY SHARE → memory inserts`. The saga never *waits* on
anything a pipeline run holds (probe is non-blocking; the claim insert is
proven conflict-free by the probe; discard-mode waiting happens while the saga
holds no row locks) — so no deadlock between the two by construction, and
every interleaving ends in one of two honest states: the receipt covers the
memories, or the memories were never admitted. Residual deadlocks between the
pipeline's reconcile stage and the saga's enumeration over a shared *memory*
row remain theoretically possible exactly as before this change; Postgres
resolves them and both retry paths converge (see the QS-B session log for the
full case analysis).

## What this does NOT change

- The saga's own delete ordering (§A.7) is untouched: memories → file
  metadata → source row → receipt → outbox, one transaction.
- No schema change: `deletion_receipt`, `counts_json`, the canonical hash
  payload, and the `memory` table are byte-identical. Migration count stays at
  0019.
- The pre-existing contract that a queued job for an already-deleted,
  row-backed source no-ops at `load()` still holds; the key cancellation just
  makes it not even load, and covers discard files where `load()` would
  succeed against the staging object.
