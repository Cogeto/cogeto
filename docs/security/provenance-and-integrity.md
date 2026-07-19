# Provenance and integrity: every claim backed by an artifact

Cogeto's central guarantee is that a remembered fact is never free-floating: it
traces to an inspectable source, and that link is enforced, not merely intended.
This document explains how provenance is represented, why it is enforced in
application code rather than a database constraint, and how a violation is caught
within one sweep cycle even in the hard cases.

## What provenance is

Every memory row carries a **NOT-NULL provenance** pair — `source_type` (one of
`note`, `chat_message`, `file_metadata`, or a minted file key for discard-mode
uploads) and `source_id` — committed in the very first migration and treated as
unbreakable schema. Edit-supersession copies a predecessor's provenance onto its
successor, so an entire same-source chain traces back cleanly with no graph walk.
Memories also carry **validity intervals** and a lifecycle status, so "what was
believed, and when" is answerable, not just "what is believed now."

This is what makes deletion enumerable (the [deletion saga](deletion-and-receipts.md)
finds everything derived from a source by its provenance) and what makes a trust
claim inspectable (you can always open the artifact a memory came from).

## Why not a foreign key

Provenance is **polymorphic**: `source_id` points at different tables depending on
`source_type`, and for discard-mode uploads it points at *no durable row at all*
(the original bytes were intentionally never stored). Postgres cannot express a
foreign key across that shape, and the alternatives were both rejected (decision
[0024](../decisions/0024-provenance-integrity-enforcement.md)):

- **Per-type FK columns** would break the frozen schema and *still* could not
  cover the discard-mode case that most needs it.
- **An insert trigger** would duplicate every connector's table knowledge inside
  SQL, add a probe on the hottest write path, and only guard `INSERT` — leaving
  the real race untouched.

So integrity is enforced by three cooperating application-level mechanisms plus a
detector.

## The two holes that were closed

A quality/security audit proved two ways an "erased" source could resurrect
memories — provenance pointing at a deleted row, covered by no receipt, invisible
to the sweep:

- **The mid-flight race (QS-5):** a source deleted while its ingestion job is
  still running (the pipeline holds a transaction open across seconds of model
  calls) could insert fresh memories *after* the delete.
- **The missing constraint (QS-37):** "no orphans, ever" was a convention, not
  something the system enforced or detected.

## The three mechanisms

1. **Admission checkpoint (ingestion side).** Immediately before inserting any
   memory row — after the slow model stages — the pipeline re-verifies the source
   row still exists under a `FOR KEY SHARE` lock. That lock conflicts with the
   saga's delete but blocks nothing else. Either the saga committed first and the
   pipeline aborts admission as a clean no-op (zero rows, an
   `ingestion.admission_aborted` audit trace), or the checkpoint locks first and
   the saga waits, then erases the fresh memories under the receipt. Both outcomes
   are honest.

2. **Cancellation guard (saga side).** Before enumerating, the saga cancels
   pending ingestion for the source through a dedicated port. A transaction-scoped
   advisory run-lock keyed on `(job_type, source_type, source_id)` lets the saga
   prove no run is in flight and consume the ingestion idempotency key itself, so
   any queued or future delivery skips before it ever loads the source. For
   discard-mode files — the one shape the checkpoint cannot cover — the guard
   waits on the run lock until the in-flight run finishes, then enumerates
   whatever it committed. The outcome (`cancelled` / `already_ran` /
   `run_in_flight`) is recorded in the deletion audit entry.

3. **Sweep detection (the backstop).** The nightly integrity sweep gains an
   orphan-memory arm with two detectors: a **receipt-side** check (any memory
   matching a confirmed receipt's source but absent from that receipt is a
   post-receipt resurrection — covers all types, discard files included) and a
   **source-side** check (memories whose adapter-backed source row no longer
   exists, with a same-transaction re-read to avoid false positives from an
   in-progress delete). Hits become persistent `orphaned_memory` integrity alerts,
   deduped and never auto-repaired, surfacing in `GET /api/health` and the System
   view. This also catches any historical residue from before the fix.

The design's own interleaving argument shows the saga never waits on anything a
pipeline run holds, so the two cannot deadlock, and every interleaving ends in one
of two honest states: **the receipt covers the memories, or the memories were
never admitted.**

## The bar this meets

The QS-37 standard was "impossible, or detected within one sweep cycle." Mechanisms
1 and 2 make the race impossible for the common paths; mechanism 3 guarantees
detection within one night for anything that slips through, including historical
data. No orphan is silently tolerated.

## Where this lives in the code

- Admission checkpoint and ingestion guard: `project/src/ingestion/` (pipeline,
  `SourceReader.existsForAdmission`, `PipelineIngestionGuard`)
- Saga cancellation + enumeration: `project/src/memory/deletion-saga.ts`
- Sweep orphan arm: `project/src/memory/` (integrity sweep)
- Tests: `project/src/ingestion/pipeline/extract-guard.spec.ts`,
  `project/src/memory/sweep-arms.integration.spec.ts`
- Design: decision [0024](../decisions/0024-provenance-integrity-enforcement.md)
