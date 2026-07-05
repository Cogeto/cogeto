# Handoff F1 → O1: how file uploads plug into the deletion saga

**Status: FROZEN.** O1 implements against this spec without redesigning it.
Any deviation requires owner sign-off first. Authority behind it: Addendum
§A.6/§A.7/§A.9/§B.1, decisions 0008 and 0009.

## 1. The upload contract (what O1 must write)

One upload = one object = one source. `source_id` **is** the object key, 1:1 —
there are no multi-object sources; a multi-file selection is N uploads.

**Object key** (§A.6, exact scheme): `{orgId}/{userId}/{scope}/file-{uuid}`
— first segment is the Zitadel organization id, NEVER a constant; `scope` is
`private` or `shared`; uuid v4 minted per upload. Mint the key BEFORE writing
anything; it is the provenance anchor in both storage modes.

**Per upload, in this order:**
1. PUT the bytes to MinIO under the key (skip entirely in discard mode, §3).
2. Insert `file_metadata` in the same transaction as the outbox enqueue
   (skip in discard mode): `object_key` (PK) · `owner_id` · `scope` ·
   `sensitive` (the upload's flag) · `upload_date` · `checksum` (sha256 hex of
   the bytes) · `size_bytes`. No new columns.
3. Enqueue the ingestion pipeline job via `withTransactionalEnqueue` with
   payload `{source_type: 'file', source_id: <object key>}`.

**Derived memories** (the pipeline does this; O1 supplies the SourceReader):
every extracted fact carries `source_type='file'`, `source_id=<object key>`,
`owner_id` = uploader, `scope` and `sensitive` inherited from the upload flags.
Provenance is NOT NULL always — enumeration-by-provenance is the saga's
correctness argument; an orphaned fact breaks provable deletion.

**SourceReader:** implement `load()` for `source_type='file'` (extract text
from the stored object) and register it with the composition roots, exactly
like `NotesSourceReader`. No `SourceDeletion` adapter for files — the saga
handles `file` sources internally via `file_metadata`.

## 2. requestSourceDeletion — the interface O1 consumes, unchanged

```
DeletionSaga.requestSourceDeletion(principal, 'file', <object key>)
  → { receiptId }        // also: previewSourceDeletion(...) → counts
DELETE /api/sources/file/:id        (:id = URL-encoded object key)
GET    /api/sources/file/:id/impact
```

Guarantees O1 may rely on (and must not re-implement):
- One transaction enumerates by provenance, deletes memory rows +
  `file_metadata`, writes the receipt `pending`, enqueues the worker job,
  audits. All-or-nothing.
- The worker deletes Qdrant points and MinIO objects (absent = success) and
  confirms the receipt with chain hash + ed25519 signature; the receipt never
  confirms while any enumerated identifier could exist; the nightly sweep
  re-verifies forever.
- Authorization is owner-only (source row and every derived memory);
  non-owners get 404.
- Cross-source supersession chains: only this source's members are deleted;
  survivors' dangling `superseded_by` pointers are nulled and recorded in
  `counts_json.superseded_by_nulled`.

## 3. Extract-and-discard (per-upload flag, per-user default — §A.9)

**Frozen (decision 0009 ruling 4):** discard mode keeps **no original: no
durable MinIO object and no `file_metadata` row**. The object key is still
minted and is still the `source_id` of every derived memory.

Extraction is slow-path work (§A.3) — the worker needs the bytes after the
request returns, so discard mode **stages** them: PUT to
`{orgId}/{userId}/staging/file-{uuid}`, enqueue the pipeline job (payload
carries the staging key and the minted source key), and the pipeline job
deletes the staging object as its final step, inside the job's idempotency
transaction commit path. Staging keys never appear in `file_metadata`, in
provenance, or in any receipt — the sweep is blind to them by construction.
A crashed job retries and re-deletes; absent staging objects are success.

**Deletion in discard mode:** `requestSourceDeletion(principal, 'file', key)`
works with no `file_metadata` row — authorization falls back to the derived
memories' owner; the receipt records the memories and `object_keys: []`. A
discarded original still yields a receipt covering the derived memories, with
zero object keys. The saga as shipped already behaves this way — O1 verifies,
never modifies.

## 4. What the cascade test must additionally cover in O1

Extend `deletion_cascade` (or add `deletion_cascade_upload`) to run against a
REAL uploaded file through the real pipeline, asserting all of:
1. Upload (stored mode) → extraction → memories exist with object-key
   provenance → delete → zero memory rows, zero points, object absent,
   `file_metadata` gone, receipt confirmed + chain-verified.
2. Discard mode: upload with the flag → memories exist → NO object, NO
   `file_metadata`, staging key gone after the pipeline job → delete → receipt
   confirmed with `object_keys: []` and correct memory counts.
3. `sensitive` upload flag: propagates to `file_metadata` (stored mode) and to
   every derived memory; deletion works identically.
4. The sweep stays clean after both cascades (`sweep_clean` still passes).

## 5. What O1 must NOT do

- **No schema changes** to `deletion_receipt`, `integrity_alert`, `memory`, or
  `file_metadata`, and no changes to `counts_json`'s shape or the canonical
  hash payload — the chain's canonicalization is pinned by a golden-hash test.
- **No new deletion paths.** Hard deletion is the saga plus the existing
  `rejectUncertain` review path. No route, job, or script may delete memory
  rows, points, or objects otherwise (staging cleanup in §3 touches only
  staging keys that no receipt references).
- **No direct Qdrant/MinIO/table access** outside the memory module's public
  interface (§A.1, 0003 ruling 2). Uploads use the module's object-store only
  through interfaces the memory module exposes for it — if one is missing,
  that is an interface addition to propose, not a client to instantiate.
- **No receipt mutation** — receipts are DB-frozen (migration 0010); do not
  disable the trigger in application code, ever.
- Deviations, including "small" ones, require owner sign-off BEFORE coding.
