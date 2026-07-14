# Memory Passport (Session O5-B — the export promise)

O5-A shipped the time-travel diff UI. This unit ships the other half of O5, the
**Memory Passport** (§B.5): a complete, documented, versioned export of a user's
own data — *your memory is portable; leave whenever you want.* Format frozen in
[decision 0029](../decisions/0029-memory-passport-format.md); the open schema is
published in [`docs/passport-schema/`](../passport-schema/). Migration **0022**
adds only the export request ledger.

## What shipped

### 1. A new `passport` bounded context

`project/src/passport/` composes the memory module's gated reads + object store
and the tasks engine (like retrieval composes them), owns only its request/status
ledger (`passport_export`), and signs the manifest with the instance key in the
worker. Public interface: `PassportModule.register(...)`, the export + retention
job types, and the format/assembler for the schema tests.

### 2. The artifact: a signed zip of open documents

`assemblePassport` (pure — format, hashing, signing, zipping) produces a `.zip`:

- `manifest.json` — passport_version, generated_at, subject, the instance public
  key, options, counts, and **every document with a SHA-256 + byte length**.
- `manifest.json.sig` — a detached **ed25519 signature over the manifest bytes**,
  so the export's integrity verifies exactly like a deletion receipt.
- `memories.json` — every memory the user may see, **any lifecycle status**, with
  content, status, scope, `sensitive`, entities, `subject_entity`, kind,
  `valid_from`/`valid_until`, `superseded_by`, provenance. The **full temporal
  record**: all versions + the successor pointers reconstruct every supersession
  chain from the archive alone.
- `tasks.json` — derived tasks with conditions and status.
- `receipts.json` — the user's deletion receipts in the exact shape `verifyChain`
  consumes, plus the public key: still **independently verifiable** outside Cogeto.
- `README.txt`, and `attachments/` when the user includes originals.

A dependency-free STORE zip writer (`zip.ts`, with a `readZip` reader for
third-party inspection) keeps the archive fully in our control and its bytes
byte-for-byte what the manifest hashed.

### 3. The export mechanism (worker-run)

Triggered from **Settings → "Export my data · Memory Passport"** (optional
"include original files"). The request row is created and the job enqueued
transactionally via the outbox (§A.3); the SPA polls status and, when ready,
downloads via a **short-lived owner-gated presigned URL** (like every other
original). The worker executor re-reads through the **same Principal-gated
interfaces** as every other read — `MemoryStore.listAllForPrincipal` (paged, all
statuses, own + visible shared), `TasksEngine.listForPrincipal(includeSettled)`,
and `MemoryStore.confirmedReceiptsForOwner` — so **a user can only ever export
what they are entitled to see**. The artifact is stored encrypted (bucket SSE-S3)
at `{org}/{user}/exports/passport-{id}.zip`, **excluded from the orphan sweep**,
and reclaimed by an **hourly retention pass** after 24h (the "short-lived" promise).

### 4. Gating (decision 0029 ruling 5)

- Own private data — included. Own **sensitive** — included, **marked** (opt-in
  owner-only read).
- **Shared** data visible to the user — included, marked `owned_by_me: false`.
- **Another user's private or sensitive data — never included** (scope + sensitive
  gates hold; sensitive is owner-only even for shared rows). Another user's file
  bytes/metadata never resolve (attachments are for the user's own uploads only).
- Cross-org isolation is total by construction (single-tenant deployment
  boundary, decision 0019).

### 5. Verifiability (decision 0029 ruling 6)

Self-describing and checkable with only the archive + published schema: verify
`manifest.json.sig` against the public key, re-hash each document against the
manifest, and verify each receipt against its chain. The schema README documents
the exact steps (incl. an OpenSSL one-liner).

## Provenance scope (v1, documented)

Provenance is `{ source_type, source_id }` + file metadata for the user's own
uploads + attachment bytes on opt-in. Inline source *bodies* (note/email text)
are a documented future extension (the `context` field is reserved, null in v1) —
consistent with §4.9 (facts, not raw documents, are Cogeto's durable
representation; the extracted memory carries the substance and the reference
locates the source). Email raw originals are reference + metadata only in v1.

## Tests

- `passport_completeness` — a seeded user's export contains every memory, its full
  history + supersession chain, tasks, and receipts (integration; real PG + Qdrant
  + MinIO, a real `store.supersede` chain).
- `passport_gating` — another user's private/sensitive never leaks; own sensitive
  marked; shared-from-a-teammate included and marked (integration).
- `passport_schema_valid` — every generated document validates against the
  published contract; `passport_version` stamped (pure).
- `passport_manifest_hashes` — each document matches its manifest SHA-256 + length;
  tampering breaks it (pure).
- `receipts_verifiable_in_export` — an exported receipt verifies against its chain
  and the included key; a tampered payload fails (pure + integration).
- Plus manifest-signature verification and attachment hashing.

No prompt/model/pipeline change → the golden-set eval gate is untouched.

## Demo (owner checklist)

1. **Export.** Settings → **Export my data · Memory Passport** → *Export my data*
   (optionally tick "include original files"). The row shows "Assembling…", then
   "Ready to download" (poll is automatic).
2. **Open.** Download the `.zip`, unzip. You get `manifest.json`,
   `manifest.json.sig`, `memories.json`, `tasks.json`, `receipts.json`, `README.txt`.
3. **Validate.** Against `docs/passport-schema/`:
   - Verify the manifest signature (README has an OpenSSL one-liner).
   - `sha256sum memories.json` and compare to `manifest.documents[].sha256`.
   - Verify a receipt against its chain + `instance_public_key_pem`.
4. **Check the gates.** As a second user, confirm the export never contains
   another member's private or sensitive facts; a teammate's shared fact appears
   marked `owned_by_me: false`.

Owner checklist:
- [ ] `docker compose up` reaches login on a fresh clone; migration 0022 applies.
- [ ] Trigger an export on the live stack; confirm ready + download works and the
      artifact validates against the published schema.
- [ ] Confirm the retention pass expires an export after its window (or verify the
      hourly `passport.retention` job is scheduled).
- [ ] Both eval suites unaffected (no prompt/model change); they run on push.

Five required checks green (`lint`, `boundaries`, `test`, `build`, `eval-gate`).
No release tag — the owner cuts releases. **O5 is complete; O6 (operator script +
runbook) is next.**
