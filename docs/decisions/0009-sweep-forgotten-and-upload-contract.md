# 0009 — Integrity sweep, Forgotten ledger, and the upload contract (Session F1-B)

**Date:** 2026-07-04 · **Status:** accepted · **Governs:** the nightly sweep's
semantics, receipt permanence, the Forgotten section's scoping, and the frozen
contract file uploads (O1) must honor — including extract-and-discard.
**Driven by:** Addendum §A.7 step 4, §A.9, §B.1, and the F1-B owner prompt.
Migration this session is **0010**.

## Ruling 1 — The sweep detects; it never repairs

The nightly sweep (03:00, graphile cron `deletion_sweep` — underscore: the
crontab parser rejects dots in task names; on demand via the
sweep entrypoint) re-derives every confirmed receipt's identifiers from
`counts_json` and verifies absence: no memory rows, no Qdrant points, no
objects. Any hit becomes an `integrity_alert` row — **never auto-deleted, never
auto-repaired**: an identifier that reappeared after a signed promise means a
human must find out how (restored backup, manual write, index rebuild), and an
automated "fix" would destroy the evidence. Alert inserts dedupe on a unique
expression index, so re-detection nightly stays one row per violation. Every
run also re-verifies the hash chain and writes a `sweep.completed` audit row —
the ledger `/api/health` and the System view read.

The sweep task is deliberately NOT wrapped in `idempotentTask` — that key fires
once ever, a sweep recurs. Its effects are idempotent by construction instead
(alert dedupe; audit rows are the run log). This is the sanctioned exception to
the §A.3 wrapper, not to §A.3's intent.

## Ruling 2 — Receipts are permanent, in the database

Migration 0010 adds a freeze trigger on `deletion_receipt`: DELETE never;
UPDATE only while `pending` (the saga's one legal transition writes hash,
signature and timestamps as it confirms). No API route mutates receipts. The
hash chain covers whoever is strong enough to disable the trigger.

## Ruling 3 — Forgotten shows the caller's own receipts

The ledger filters on `counts_json->>'requested_by'` — the deleting principal,
recorded inside the signed payload (0008 ruling 6). Chain verification remains
instance-wide (`/api/receipts/verify` walks all confirmed receipts). A jsonb
filter suffices at single-tenant volume; if the Forgotten list ever needs an
index, add a receipt `owner_id` column THEN — new column, no reinterpretation.

## Ruling 4 — Extract-and-discard: no bytes, no file_metadata, receipt with zero objects

Frozen for O1 (the full contract lives in `docs/handoff/F1-deletion-saga.md`):
with extract-and-discard ON, the original bytes are **never written to MinIO
and no `file_metadata` row is created** — §A.6 defines `file_metadata` as
pointers to original bytes; no bytes, no pointer. Derived memories still carry
`source_type='file'` and `source_id=<the minted object key>` (the key is minted
either way, so provenance stays uniform). Deleting such a source enumerates and
removes the derived memories; the saga authorizes via the memories' owner (no
source row exists), and the receipt records `object_keys: []` — a discarded
original still yields a receipt covering the derived memories, with zero object
keys. The current saga implements this behavior already; O1 changes nothing.

*Rejected alternative:* a `file_metadata` row with a "discarded" marker — needs
a schema change to a §A.6 contractual table and keeps a record the user asked
not to keep.
