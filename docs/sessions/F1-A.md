# Session F1-A — deletion saga and receipts (§A.7, §B.1)

**Date:** 2026-07-04 · **Scope:** F1-A owner prompt, sections 1–7. The sweep,
Forgotten UI, and the O1 handoff spec are Prompt F1-B. Design rulings are in
**decision 0008**; the migration this session is **0009**.

## What shipped

### §1 MinIO encryption at rest (audit 3.9 closed)

- `MINIO_KMS_SECRET_KEY` single-node KMS on the `minio` service (dev-only
  default in compose; per-instance generation guidance in `.env.example`).
- `minio-init` now sets **SSE-S3 default bucket encryption** and asserts the
  bucket reports it — compose up fails loudly otherwise. (First live run caught
  that the `mc` image has no `grep`; the assertion is a shell `case` match.)
- `GET /api/health` gained a `minioEncryption` check (signed
  GetBucketEncryption via the object-store client), shown in the System panel.
- `.env.example`: MinIO section label corrected (was claiming encryption that
  didn't exist — audit 5.2), `MINIO_KMS_SECRET_KEY` documented, and the audit
  2.10 vars (`COGETO_MIGRATIONS_DIR`, `COGETO_PROMPTS_DIR`, plus the new
  `COGETO_INSTANCE_KEY_DIR`) documented.

### §2 Instance signing key

ed25519 keypair generated at first boot by the **migrate init job** into the
new `instance-keys` volume (rw only there; ro in app/worker; private key 0600).
`GET /api/instance/public-key` (unauthenticated) serves the public half.
`node:crypto` only — no new dependency. Infrastructure: `instance-key.ts`.

### §3–§5 The saga (`memory/deletion-saga.ts`, replacing DeletionSagaStub)

- **`DeletionSaga.requestSourceDeletion(principal, sourceType, sourceId)`** —
  ONE transaction: enumerate by provenance (FOR UPDATE), null dangling
  `superseded_by` pointers of cross-source survivors (recorded in the receipt),
  delete memory rows, delete `file_metadata`/collect object keys (file
  sources), delete the source row via the new **SourceDeletion port**
  (`NotesSourceDeletion` in connectors — the SourceReader mirror), write
  receipt `pending` with `counts_json` (memory ids/count, point ids, object
  keys, source ref, requested_by, enumeration timestamp, nulled pointers),
  outbox-enqueue `deletion.execute` keyed to the receipt id, audit. Owner-only;
  non-owners get NotFound. `previewSourceDeletion` gives the confirm dialog its
  exact numbers.
- **`DeletionExecutor.execute`** (worker job `deletion.execute`, idempotency
  key `(deletion_receipt, <receipt id>)`): Qdrant point deletion (absent =
  success) → MinIO object deletion (absent = success) → confirm with chain
  hash + signature, all in the one idempotency transaction. Partial failure →
  receipt stays pending, graphile retries; exhaustion → dead_letter (System
  view), never a premature confirm.
- **Hash chain** (`memory/domain/receipt-chain.ts`, pure): canonical JSON
  (sorted keys, golden-hash-pinned), SHA-256 chained via `prev_hash` from a
  genesis constant, ed25519-signed. Chain order IS the linkage (never
  timestamps); confirmation serialized by an advisory lock. `verifyChain()` +
  `GET /api/receipts/verify`. Migration 0009 adds the `signature` column.
- **Object storage client**: minimal SigV4 client in the memory module
  (decision 0008 ruling 3) — no SDK dependency.

### §6 Delete affordances + dev seed

- `DELETE /api/sources/:type/:id` + `GET /api/sources/:type/:id/impact`.
- The source drawer (note detail, now reachable from the memory drawer's
  Provenance panel via "Open source · delete…") gained a danger zone whose
  confirm dialog states exactly: the source, N derived memories, and any stored
  files are permanently removed and a signed receipt issued.
- `npm run seed:object` / `docker compose --profile dev-seed run --rm
  seed-object --owner <id> --org <id>` places one MinIO object +
  `file_metadata` row + derived memory. The runtime image deletes the script;
  the compose service runs the build-stage image, profile-gated.

### Fixed on the way

`MemoryVectorStore.setPayload` documented "missing point = no-op" but threw
Qdrant's 404 — editing or toggling a not-yet-embedded memory would have 500'd.
Now matches its contract (exposed by `cross_source_chain`, which edits an
unembedded memory).

## Cross-source chain design decision (ruling 5, tested)

Deleting source S removes only S's members of a supersession chain. Surviving
members pointing at deleted rows get `superseded_by` **nulled** (the
self-referencing FK requires it anyway) and the receipt records those ids under
`superseded_by_nulled`. Survivors keep provenance and status — only the link to
the erased row disappears, so S's erasure is not reconstructable from what
survives.

## Tests (the exit bar) — all green

| Test | Result |
|---|---|
| `deletion_cascade` (DoD gate: note + seeded object → zero rows/points/bytes/metadata, receipt confirmed + signed, audited) | ✅ |
| `saga_atomic_intent` (injected enumeration failure → nothing changed anywhere) | ✅ |
| `saga_partial_failure_converges` (Qdrant down once → pending; retry confirms exactly once; duplicate delivery skips) | ✅ |
| `receipt_never_premature` (permanent object failure → dead-letter, receipt pending; dashboard retry converges after recovery) | ✅ |
| `chain_integrity` (3+ receipts verify; tampering payload/signature breaks verifyChain; restore heals) | ✅ |
| `authz_owner_only` (non-owner delete + preview → NotFound; data intact) | ✅ |
| `cross_source_chain` (same-source chain deletes whole; cross-source nulls + records pointer) | ✅ |
| `bucket_encryption` (bucket reports SSE-S3 — the health-check assertion) | ✅ |
| receipt-chain unit suite (canonicalization key-order/unicode/golden hash; verifyChain forgery cases) | ✅ 10/10 |

Full battery: **build ✅ · lint ✅ · boundaries ✅ (175 modules, 0 violations) ·
tests ✅ 69 passed + 1 skipped (live suite) · compose-to-login ✅** (SPA 200,
API 401 unauthenticated, Zitadel login 302; health `ok` including
`minioEncryption`; migration 0009 applied; keypair generated 0600 in the
volume; runtime image verified to exclude `seed-object.js`).

## Demo (owner)

```bash
# 0. Stack up (rebuild picks up migration 0009 + SSE + instance keys)
docker compose up -d --build

# 1. Your ids (log in first): userId + orgId
curl -sk https://localhost/api/me -H "authorization: Bearer $TOKEN"

# 2. Seed the object leg (dev-only, build-stage image)
docker compose --profile dev-seed run --rm seed-object --owner <userId> --org <orgId>

# 3. UI path: Memories → open the seeded memory (or any note-derived one) →
#    Provenance → "Open source · delete…" → Danger zone → Delete source…
#    (the dialog shows the exact counts from /impact)

# 4. API path (file source from step 2; sourceId is URL-encoded object key):
curl -sk -X DELETE "https://localhost/api/sources/file/<urlencoded objectKey>" \
  -H "authorization: Bearer $TOKEN"
# → {"receiptId":"…"}

# 5. Verify the chain
curl -sk https://localhost/api/receipts/verify -H "authorization: Bearer $TOKEN"
# → {"ok":true,"verified":N,"confirmed":N,"pending":0}
curl -sk https://localhost/api/instance/public-key
```

Receipt inspection query:

```bash
docker compose exec postgres psql -U postgres -d cogeto -c \
  "SELECT id, source_type, status, left(hash,16) AS hash, left(prev_hash,16) AS prev,
          counts_json->>'memory_count' AS memories, counts_json->'object_keys' AS objects,
          signed_at, confirmed_at
   FROM deletion_receipt ORDER BY confirmed_at NULLS LAST;"
```

MinIO console check (no console port is published; use mc):

```bash
docker run --rm --network cogeto_default --entrypoint /bin/sh minio/mc:latest -c \
  'mc alias set local http://minio:9000 cogeto cogeto-dev-password >/dev/null &&
   mc encrypt info local/cogeto && mc ls --recursive local/cogeto'
# expect: "Auto encryption 'sse-s3' is enabled"; after a delete, the object is gone
```

## Owner checklist

- [ ] `docker compose up -d --build`, log in, capture a note, wait for
      processing, then delete it from the source drawer — confirm the dialog
      wording and that the memories vanish from every list.
- [ ] Run the seed (`--profile dev-seed`) with your ids and delete the file
      source; check `mc ls` shows no object and `file_metadata` is empty.
- [ ] `GET /api/receipts/verify` returns `ok:true` with your deletions counted;
      `GET /api/instance/public-key` returns the PEM.
- [ ] System panel shows "MinIO encryption — up · SSE-S3 default encryption on"
      and dead-letter empty.
- [ ] For a real instance: generate `MINIO_KMS_SECRET_KEY` per `.env.example`
      **before first boot** and back it up with the instance secrets (ruling 1
      rotation caveat: static key; KES rotation is Later).
- [ ] Sign-off items: decision 0008 rulings (esp. cross-source chain semantics,
      ruling 5, and the no-SDK SigV4 client, ruling 3); receipt `requested_by`
      living in `counts_json` until F1-B decides on a column.

**Next (F1-B):** nightly orphan sweep, Forgotten UI (receipt list + PDF/JSON
export), and the frozen `docs/handoff/F1-deletion-saga.md` for O1 file uploads.
