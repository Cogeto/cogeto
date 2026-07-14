# 0029 — Memory Passport export format (Session O5-B)

**Date:** 2026-07-14 · **Status:** accepted · **Governs:** the on-disk format of
the Memory Passport (§B.5), what it contains, how originals/shared/sensitive data
are handled, and how the artifact is made independently verifiable. **Driven by:**
Addendum §B.5 (one-click export in an open, documented, versioned format — the
anti-lock-in promise), §A.6 (the schema already holds everything), §B.1 (deletion
receipts + instance signing key), decision 0008 (instance ed25519 key). Migration
this session is **0022** (the `passport_export` request ledger only).

## Ruling 1 — A zip of JSON documents + a signed manifest, not a single JSON

The Passport is **a single `.zip`** containing a top-level `manifest.json`, one
JSON document per data kind, a `README.txt`, and an `attachments/` folder.

*Zip over single-JSON, justified:* the full archive carries **binary originals**
(uploaded files) alongside JSON. A single JSON blob would force base64-embedding
binaries — inflating size ~33% and making the export unreadable as plain files.
A zip keeps every document independently openable and hashable, and holds the
originals as real files. Entries are **STORE (uncompressed)** so a document's
bytes in the archive are byte-for-byte the bytes the manifest hashed — no
decompression needed to verify. A dependency-free writer keeps the format fully
in our control (no new dependency).

Archive layout (v1):

```
manifest.json         signed index: version, timestamp, public key, per-document sha256
manifest.json.sig     detached ed25519 signature (base64) over manifest.json's bytes
memories.json         every memory, full history + supersession pointers
tasks.json            derived tasks with conditions + status
receipts.json         deletion receipts (chain hashes + signatures + public key)
README.txt            human pointer to the schema + how to verify
attachments/…         original file bytes, only when the user opts in
```

## Ruling 2 — A published, versioned schema (`passport_version`)

The format is **open**: the JSON Schema (Draft 2020-12) and a human spec live in
[`docs/passport-schema/`](../passport-schema/), versioned by `passport_version`
(currently **`1.0`**), stamped into every document. A third party reads and
verifies a Passport with **only** the published schema and the included public
key — never any Cogeto code or service. The in-code contract
(`project/src/passport/passport-format.ts`, Zod) and the published JSON Schema are
kept in lockstep and both keyed to `passport_version`; the `passport_schema_valid`
test re-validates the generated artifact against the in-code contract so drift
fails the build. A breaking change bumps `passport_version` and publishes a new
schema; old versions stay readable.

## Ruling 3 — Contents: the complete record, not the current state

- **memories.json** — every memory the user may see, in **any lifecycle status**
  (`replaced`/`outdated` included), each with content, status, scope, `sensitive`
  flag, entities, `subject_entity`, kind, **`valid_from`/`valid_until`** and
  `superseded_by`. The full validity history and supersession chains are the set
  of all versions plus these pointers — the temporal record reconstructs from the
  export alone, no server needed.
- **provenance** — every memory carries `{ source_type, source_id }` (the
  reference) plus, for the user's own file uploads, file metadata (filename,
  content type, size) and — when originals are included — the `attachment_path`.
  Rationale for reference-level provenance: Cogeto's durable representation is the
  **extracted fact** (scope §4.9: facts, not raw documents, are stored); the fact
  carries the substance and the reference locates the source. Richer inline
  source bodies (note/email text) are a documented future extension; the `context`
  field is reserved for it (null in v1).
- **tasks.json** — derived tasks with `condition_text`, `status`, `due`,
  `dormant`, `from_uncertain`, and the deriving memory id.
- **receipts.json** — the user's confirmed deletion receipts in the exact shape
  `verifyChain` consumes (id, source/target, `counts_json`, `signed_at`,
  `confirmed_at`, `prev_hash`, `hash`, `signature`) plus the instance public key,
  so each receipt stays **independently verifiable against its chain** outside
  Cogeto (§B.1).

## Ruling 4 — Originals: reference-only by default, opt-in for the bytes

Original files are **reference-only by default** (metadata + provenance in
`memories.json`). A per-export toggle, **Include original files** (default
**off**), attaches the original bytes of the user's own uploads under
`attachments/`. Rationale: the common case is a compact, portable record; the
full binary archive is an explicit choice. Email raw originals are **reference +
metadata only** in v1 (a documented future extension); the extracted email facts
and provenance are always present.

## Ruling 5 — Gating: own data + legitimately-visible shared; sensitive marked

The export runs a **worker job that re-reads through the same Principal-gated
interfaces** as every other read — it can only ever include what the user is
entitled to see. Specifically:

- **Own private data** — included.
- **Shared data the user can legitimately see** — included, each fact marked
  `owned_by_me: false` with its `owner_id`. Another user's original file **bytes
  and file metadata are never included** (attachments/file provenance resolve for
  the user's OWN uploads only).
- **Another user's private data** — never included (the scope gate).
- **Sensitive data** — included in the **owner's own** export (opt-in read,
  owner-only), clearly marked with the `sensitive` flag. A teammate's sensitive
  facts never appear (the sensitive gate holds — owner-only even for shared).
- **Cross-org isolation** — total (single-tenant deployment boundary, decision
  0019; the gate excludes other-owner private regardless).

## Ruling 6 — The Passport is self-describing and checkable

The manifest lists **every document with its SHA-256 hash and byte length**, and
is itself **signed with the instance ed25519 key** (`manifest.json.sig`, over the
exact `manifest.json` bytes) — the export's integrity verifies **exactly like a
deletion receipt**. Verification, using only the archive + the published schema:

1. Verify `manifest.json.sig` against `manifest.json` using
   `instance.public_key_pem` (cross-check that key against
   `GET /api/instance/public-key`).
2. For each `manifest.documents[]`, SHA-256 the file and compare hash + length.
3. Verify each receipt in `receipts.json` against its hash chain and the key.

## Ruling 7 — Short-lived, encrypted, owner-scoped delivery

The artifact is stored at `{org}/{user}/exports/passport-{id}.zip` — the bucket's
default SSE-S3 encryption covers it at rest; delivery is a **short-lived presigned
URL** from an owner-gated endpoint (like every other original, §A.9). Export
objects are **excluded from the orphan sweep** (they are not `file_metadata`-backed)
and reclaimed by an **hourly retention pass** that deletes the object and marks
the row `expired` after a 24-hour window — the "short-lived" promise, enforced.
The `passport_export` table is the request/status ledger the SPA polls; it holds
no memory content.
