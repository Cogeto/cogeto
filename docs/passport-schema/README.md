# Cogeto Memory Passport — open format (v1.0)

The **Memory Passport** is a complete, portable export of a user's data from
Cogeto, in an **open, documented, versioned** format. You are not locked in: this
directory is the whole specification. Anyone can read a Passport, and verify its
integrity, with only these schemas and the public key inside the archive — no
Cogeto code or service required.

Binding format decision: [`docs/decisions/0029-memory-passport-format.md`](../decisions/0029-memory-passport-format.md).

## The archive

A Passport is a single `.zip` (entries stored uncompressed, so each document's
bytes are exactly what the manifest hashed):

| Path                | What it is                                                                 |
| ------------------- | -------------------------------------------------------------------------- |
| `manifest.json`     | Signed index: version, timestamp, instance public key, per-document SHA-256 |
| `manifest.json.sig` | Detached ed25519 signature (base64) over the exact bytes of `manifest.json` |
| `memories.json`     | Every memory, full validity/supersession history (not just current state)   |
| `tasks.json`        | Tasks derived from memories, with conditions and status                     |
| `receipts.json`     | Deletion receipts, still independently verifiable against their chain        |
| `README.txt`        | A short human pointer (generated into each archive)                         |
| `attachments/…`     | Original file bytes — only if the user chose "include original files"        |

Every document is described by a JSON Schema (Draft 2020-12) here:
`manifest.schema.json`, `memories.schema.json`, `tasks.schema.json`,
`receipts.schema.json`. Every document carries `passport_version` (`"1.0"`); a
breaking change bumps it and publishes a new schema, and old versions stay
readable.

## What's included (and what isn't)

- **All of your memories** you may see — every lifecycle status, including
  `replaced`/`outdated`, each with content, status, scope, the `sensitive` flag,
  entities, `subject_entity`, `valid_from`/`valid_until`, `superseded_by`, and
  provenance. The **full temporal record** reconstructs from the export alone:
  the set of all versions plus the `superseded_by` pointers is the complete
  history and supersession chains.
- **Shared data you can legitimately see** is included, each fact marked
  `owned_by_me: false` with its `owner_id`. **Another user's private data is never
  included.** A teammate's original file bytes and file metadata are never
  included — attachments and file provenance resolve for your **own** uploads only.
- **Sensitive data** is included in **your own** export, clearly marked with the
  `sensitive` flag.
- **Original files**: reference-only by default (metadata + provenance). Turn on
  "include original files" to attach the original bytes of your uploads under
  `attachments/`. Email raw originals are reference + metadata only in v1.
- **Deletion receipts** are exported in full (hashes, signatures, the instance
  public key) so they remain verifiable outside Cogeto.

## Verify a Passport (using only this archive + the schemas)

1. **Schema.** Validate each document against its schema above.
2. **Manifest signature.** Verify `manifest.json.sig` (base64 ed25519) against the
   exact bytes of `manifest.json`, using `manifest.instance.public_key_pem`. You
   can cross-check that key against the instance endpoint `GET /api/instance/public-key`.
3. **Document hashes.** For each entry in `manifest.documents`, compute the
   SHA-256 of the file's bytes and confirm it equals `sha256` and that the byte
   length equals `bytes`.
4. **Receipts.** For each receipt in `receipts.json`, recompute its `hash` from
   the canonical payload (see below) and verify its `signature` against
   `instance_public_key_pem`; walk the chain by `prev_hash` from the genesis
   constant `cogeto:deletion-receipt-chain:genesis`.

Example (OpenSSL, manifest signature):

```sh
# public key → PEM file
jq -r .instance.public_key_pem manifest.json > pub.pem
# signature is base64 → raw bytes
base64 -d manifest.json.sig > manifest.sig
openssl pkeyutl -verify -pubin -inkey pub.pem -rawin -in manifest.json -sigfile manifest.sig
```

Receipt hash canonicalization (matches the deletion-receipt chain): SHA-256 over
UTF-8 of the JSON of `{ id, source_type, source_id, counts_json, signed_at,
confirmed_at, prev_hash }` with **object keys sorted lexicographically at every
depth**, arrays in order, timestamps as ISO-8601 UTC. The signature is ed25519
over the hex `hash` string.

## Sample

[`sample/`](sample/) holds a small, **fictional** Passport (Ana, a demo persona).
It is illustrative: its hashes and signatures are placeholders, not real crypto —
generate a real Passport from Settings → "Export my data" to see live values.
