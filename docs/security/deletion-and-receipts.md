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

- **Postgres**: the memory rows, for file sources the `file_metadata` pointer
 rows, and the **suppressed-fact log** entries derived from the source.
- **Qdrant**: the vector points for those memories.
- **MinIO**: the stored original object bytes.

The suppressed-fact log (V2.0 item 3.3) is a content-bearing table: it records
every automatic decision that demoted or withheld an extracted fact, and each
entry carries the claim as extracted and the exact source span it came from,
including for facts that were withheld and therefore have no memory row at all.
It joins the cascade through the same `DerivedCascade` port every other derived
artifact uses, over **every enumerated source** rather than only the one the
delete was addressed to, so an email attachment's entries cannot survive its
email. The receipt counts them under `suppressed_facts_removed`. A content-bearing
table the saga could not reach would be a regression against the promise this
whole document is about.

The saga runs in two parts:

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

## Erasing a departed user's material

Owner-only authorization has one deliberate exception, added because its
absence was a hole in exactly the guarantee this document is about. When
someone leaves and their account is deactivated, nobody could read their
private material and nobody could delete it either, so an erasure request
could only be satisfied by editing Postgres, Qdrant and MinIO by hand, which
produces no receipt and leaves no trace.

**Owner erasure** is an administrative action (the operator role, a typed
confirmation naming the subject, audited with both the actor and the subject)
that runs **the saga above, unchanged**, once per source the departed user
owned. Not a second deletion mechanism: same enumeration, same cascades, same
all-or-nothing transaction, same signed and chained receipt, same nightly
sweep. What is new is who may invoke it and over what set.

It works from the stored `owner_id` alone. Nothing in the path resolves the
subject against the identity provider, because the state it exists for is
precisely the one where that lookup fails.

**The scope rule: private material is erased, shared material always stays,
without exception.** Two checks enforce it. A source whose own row records
`shared` is never attempted; and inside the saga's transaction, over the
complete enumeration including cascade members, a source is retained whole if
ANY fact derived from it is shared. The second check is the one that matters:
scope is stamped from the source at ingestion but a user can re-scope a single
memory afterwards, so a private source can hold a shared fact, and the saga
deletes by provenance. Retaining more than strictly necessary is the direction
the rule requires, and every retention is reported with its reason rather than
being a silent skip.

**The receipt shape is one per source, not one per erasure.** That is the shape
a data subject can actually use: each receipt verifies on its own against the
published public key and names exactly what it removed, so any single claim in
the set can be checked. One aggregate receipt would verify as a whole or not at
all, and a partial failure would leave the entire attestation `pending`. The
set is bracketed in the audit trail by `user.erasure_requested` and
`user.erased`, so the evidence is one audited run plus N individually
verifiable receipts, each linked into the chain of the space its source
lived in (an erasure spans the subject's spaces; each receipt joins its own
space's chain).

The operator procedure is [runbook §4d](../operator-runbook.md#4d-erasing-a-departed-users-data).

## The receipt and its chain

Each confirmed receipt is signed with the instance's own **ed25519 key**,
generated at first boot into a protected volume and never placed in the repo or
image. The signed payload is canonicalized
deterministically (sorted keys at every depth, stable array order) and hashed with
SHA-256; the signature covers that hash.

Receipts are **hash-chained, one chain per space**
([docs/features/spaces.md](../features/spaces.md) section 5 as amended): each
receipt links via `prev_hash` to the previous confirmed receipt **within its
space**, back to a fixed genesis constant that is the same for every space
(chains are distinguished by the receipt's `space_id` column, which sits
beside the hashed payload, never inside it). Each space owns its own genesis,
its own sequence and its own tip, so a space's receipts verify standalone,
which is what the per-space passport exports. The pre-spaces chain is the
default space's chain, byte-identical: every historical receipt verifies
exactly as it did. Crucially, **linkage defines the chain order, never
timestamps**, confirmation serializes on a per-space advisory lock and finds
the tip as "the confirmed receipt no other confirmed receipt in the space
links to," so clock skew cannot fork or reorder a chain, and more than one
tip within a space is treated as corruption and refused. A golden-hash test
pins the canonicalization forever so the format cannot drift.

Receipts are also **permanent**: a database trigger forbids `DELETE` outright and
allows `UPDATE` only while a receipt is still `pending` (the one legal transition,
as the saga confirms it). No API route mutates a receipt.

## Memory Passport exports expire with the deletion

A passport export (spec §11.4) is a signed ZIP of everything its owner could see
when it was assembled. Nothing used to re-open it when a source was deleted, so
for up to the retention window a confirmed receipt said "provably deleted" while
a downloadable artifact still held the erased content and the download endpoint
still minted presigned URLs for it. That is the signed receipt over-claiming,
which is the one failure this mechanism cannot afford (audit 2.0 SEC-8).

**The rule, and why it is the one we chose.** A source deletion expires **all**
of the owner's ready and in-progress exports, unconditionally. It is not
content-scoped. Deciding whether a particular ZIP contains a particular erased
memory would mean opening the archive, which is expensive, needs exactly the
plaintext we are erasing, and fails open on any bug. Unconditional expiry is a
one-line rule with an obvious proof, and an export is cheap to regenerate: the
cost of being too aggressive is a user pressing Export again, and the cost of
being too narrow is a receipt that lies. In-progress (`pending`) exports are
expired too, because the worker assembling them may already have read the doomed
rows.

Mechanically it reuses the machinery that was already there. The expiry runs
inside the enumeration transaction, marks the rows `expired` and clears their
object key, and hands the object keys back to the saga, which folds them into the
receipt's `object_keys`. The **worker leg** erases the bytes and the nightly
sweep verifies them absent, exactly like a file or an email body. The receipt
also carries `passport_exports_expired`, a count: **optional and additive**, so
every earlier receipt parses unchanged and hashes to the same value, and the
chain verifies across the change. The download endpoint refuses an expired export
by name, saying why, rather than reporting a generic "not ready".

## The export lifecycle is audited

Producing an export is the highest-impact data movement in the product, a signed
copy of one user's entire memory, and it used to leave no entry at all in the
append-only trail (audit 2.0 SEC-9). Three events are now recorded, structural
metadata only, never content:

| Action | Written when |
|---|---|
| `passport.export_requested` | the user triggers an export |
| `passport.export_ready` | the worker has assembled and stored the artifact |
| `passport.export_downloaded` | a presigned URL is minted, the moment the bytes become reachable outside the instance |
| `passport.export_expired` | a source deletion expired the owner's exports |

## A receipt is written only when something was erased

A receipt attests erasure, so it is written when something was actually erased
and withheld when nothing was (audit 2.0 SEC-30). Empty attestations are noise in
the one artifact whose entire value is that every entry means something.

**Removing the source row counts as erasure.** Deleting a note captured moments
ago erases the note itself and consumes its pipeline idempotency key, so a
receipt reading "0 memories" is the honest record of a real deletion, not an
empty one. An earlier revision suppressed that receipt and was wrong to.

The genuinely vacuous case, a source that exists nowhere at all, is already
refused upstream with a 404. The guard is kept as defence in depth: if it ever
fires, no receipt is written and the API returns a null `receiptId`.

## The nightly sweep detects, never repairs

A nightly integrity sweep re-derives every confirmed receipt's identifiers from
its `counts_json` and verifies they are still absent: no memory rows, no Qdrant
points, no objects, and re-verifies every space's hash chain. Any reappearance
becomes a persistent `integrity_alert`. It is **never auto-deleted or
auto-repaired**: an identifier that came back after a signed promise means a human
must find out how (a restored backup, a manual write, an index rebuild), and an
automated "fix" would destroy the evidence. Alerts
surface in `GET /api/health` and the System view.

## How you verify it

- **Verify the whole chain:** `GET /api/receipts/verify` walks genesis to tip,
 recomputing every hash and checking every signature. The walk covers the whole
 chain of the caller's current space, because a subset of a hash chain verifies
 nothing and the space's chain is the whole that a space's receipts can
 reference; the nightly sweep verifies every space's chain. The counts it
 returns are the caller's own unless they hold the admin role, and the
 first-failure string is admin-only (V2.0 item 3.7). So "the chain your receipts
 sit in verifies" is answerable by any user, and the instance's totals are not.
- **Verify one exported receipt independently:** `GET /api/instance/public-key`
 serves the instance's public key **unauthenticated**, so anyone holding an
 exported receipt can check its signature without access to the instance.
- **Detect a silently dropped receipt from a single exported copy:** every
 exported receipt embeds a `chainTip` = `{ hash, confirmedCount }` at export time. Re-run verify later: if the tip you recorded no longer appears, or
 the confirmed count has gone *down*, a receipt was removed or the chain
 truncated. This turns a silent operator tamper into a checkable discrepancy from
 an independently held artifact.

## Related guarantees and residual notes

- **Cross-source supersession chains:** deleting source S removes only S's
 members; a surviving memory from a different source whose pointer referenced a
 deleted row has that pointer nulled, and the receipt records it, erasure of S
 must not be reconstructable from what survives.
- **Discard-mode uploads** (extract-and-discard on) never write the original bytes
 to MinIO at all; deleting such a source still yields a receipt covering the
 derived memories, with zero object keys.
- **The chain tip is an anti-tamper anchor, not a proof of completeness.** Proving
 that *everything* promised was erased is the sweep's job; the tip proves the
 ledger itself was not quietly truncated.
- **Suppressed-fact log retention:** entries live for the life of their source and
 die with it. They are the evidence for a decision about that source, so
 outliving it would mean retaining source content after a signed receipt said it
 was erased.
- **Key loss:** the MinIO encryption master key and the signing key live in the
 instance's secrets and are backed up with them. Losing the encryption key makes
 stored objects unreadable by design.

## Where this lives in the code

- Saga: `project/src/memory/deletion-saga.ts`
- Sweep arms: `project/src/memory/` (integrity sweep, orphan/absence detectors)
- Tests: `project/src/memory/deletion.integration.spec.ts`,
 `email-deletion-cascade.integration.spec.ts`,
 `sweep-arms.integration.spec.ts`,
 `project/src/ingestion/auto-review-resolution.integration.spec.ts`
 (`log_deletion_cascade`)
