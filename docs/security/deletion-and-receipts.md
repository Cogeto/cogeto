# Verifiable deletion and signed receipts

When you delete a source in Cogeto, "deleted" is not a claim you have to take on
faith. The delete runs as a saga that erases every derived artifact across all
three stores, and it produces a **cryptographically signed receipt** that is
hash-linked into a tamper-evident chain. A nightly sweep independently confirms
the promise held. This document explains the mechanism and how you verify it
yourself.

## What a delete actually removes

Memory in Cogeto is *derived* from a source (a note, a document, an email). A
source's derived memories carry that source's provenance, so deleting the source
enumerates and erases everything derived from it across:

- **Postgres** — the memory rows and, for file sources, the `file_metadata`
  pointer rows.
- **Qdrant** — the vector points for those memories.
- **MinIO** — the stored original object bytes.

The saga runs in two parts (decision
[0008](../decisions/0008-deletion-saga-and-encryption.md), ruling 4):

1. **One Postgres transaction (app):** enumerate the derived memories by
   provenance `FOR UPDATE`, delete them, delete file metadata and collect object
   keys, delete the source row, insert a `pending` receipt with a `counts_json`
   of exactly what will be erased, enqueue the worker job through the outbox, and
   write the audit row. Any failure aborts the whole thing.
2. **One idempotent worker attempt:** delete the Qdrant points, delete the MinIO
   objects, then confirm the receipt with its chain hash and signature in the
   same idempotency transaction. If an external delete fails, the confirmation
   rolls back and retries; on exhaustion the job parks in the dead-letter table
   with the receipt still `pending`. **A receipt can never read `confirmed` while
   any enumerated identifier could still exist.**

Authorization is owner-only, checked against the source row *and* every derived
memory row; a mismatch returns `NotFound` so existence never leaks.

## The receipt and its chain

Each confirmed receipt is signed with the instance's own **ed25519 key**,
generated at first boot into a protected volume and never placed in the repo or
image (decision 0008, ruling 2). The signed payload is canonicalized
deterministically (sorted keys at every depth, stable array order) and hashed with
SHA-256; the signature covers that hash.

Receipts are **hash-chained**: each links to the previous confirmed receipt via
`prev_hash`, back to a fixed genesis constant. Crucially, **linkage defines the
chain order, never timestamps** — confirmation serializes on an advisory lock and
finds the tip as "the confirmed receipt no other confirmed receipt links to," so
clock skew cannot fork or reorder the chain, and more than one tip is treated as
corruption and refused. A golden-hash test pins the canonicalization forever so
the format cannot drift.

Receipts are also **permanent**: a database trigger forbids `DELETE` outright and
allows `UPDATE` only while a receipt is still `pending` (the one legal transition,
as the saga confirms it). No API route mutates a receipt (decision
[0009](../decisions/0009-sweep-forgotten-and-upload-contract.md), ruling 2).

## The nightly sweep detects, never repairs

A nightly integrity sweep re-derives every confirmed receipt's identifiers from
its `counts_json` and verifies they are still absent — no memory rows, no Qdrant
points, no objects — and re-verifies the whole hash chain. Any reappearance
becomes a persistent `integrity_alert`. It is **never auto-deleted or
auto-repaired**: an identifier that came back after a signed promise means a human
must find out how (a restored backup, a manual write, an index rebuild), and an
automated "fix" would destroy the evidence (decision 0009, ruling 1). Alerts
surface in `GET /api/health` and the System view.

## How you verify it

- **Verify the whole chain:** `GET /api/receipts/verify` walks genesis to tip,
  recomputing every hash and checking every signature.
- **Verify one exported receipt independently:** `GET /api/instance/public-key`
  serves the instance's public key **unauthenticated**, so anyone holding an
  exported receipt can check its signature without access to the instance.
- **Detect a silently dropped receipt from a single exported copy:** every
  exported receipt embeds a `chainTip` = `{ hash, confirmedCount }` at export time
  (decision [0026](../decisions/0026-token-revocation-window-and-receipt-chain-anchor.md),
  ruling 2). Re-run verify later: if the tip you recorded no longer appears, or
  the confirmed count has gone *down*, a receipt was removed or the chain
  truncated. This turns a silent operator tamper into a checkable discrepancy from
  an independently held artifact.

## Related guarantees and residual notes

- **Cross-source supersession chains:** deleting source S removes only S's
  members; a surviving memory from a different source whose pointer referenced a
  deleted row has that pointer nulled, and the receipt records it — erasure of S
  must not be reconstructable from what survives (decision 0008, ruling 5).
- **Discard-mode uploads** (extract-and-discard on) never write the original bytes
  to MinIO at all; deleting such a source still yields a receipt covering the
  derived memories, with zero object keys (decision 0009, ruling 4).
- **The chain tip is an anti-tamper anchor, not a proof of completeness.** Proving
  that *everything* promised was erased is the sweep's job; the tip proves the
  ledger itself was not quietly truncated.
- **Key loss:** the MinIO encryption master key and the signing key live in the
  instance's secrets and are backed up with them. Losing the encryption key makes
  stored objects unreadable by design.

## Where this lives in the code

- Saga: `project/src/memory/deletion-saga.ts`
- Sweep arms: `project/src/memory/` (integrity sweep, orphan/absence detectors)
- Tests: `project/src/memory/deletion.integration.spec.ts`,
  `email-deletion-cascade.integration.spec.ts`,
  `sweep-arms.integration.spec.ts`
- Design: decisions
  [0008](../decisions/0008-deletion-saga-and-encryption.md),
  [0009](../decisions/0009-sweep-forgotten-and-upload-contract.md),
  [0026](../decisions/0026-token-revocation-window-and-receipt-chain-anchor.md)
