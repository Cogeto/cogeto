# 0014 — File upload + document extraction (Session O1-A)

**Date:** 2026-07-06 · **Status:** accepted · **Governs:** the file source
(upload endpoint, storage, PDF/DOCX extraction into the existing pipeline),
the memory-owned file-metadata + object-store ports the file source uses,
presigned download URLs, and the composition wiring. **Driven by:** the frozen
F1 handoff (`docs/handoff/F1-deletion-saga.md` — upload contract, no schema
changes), Addendum §A.6/§A.9/§A.3/§B.3, decisions 0003 (memory owns all
storage) and 0008 (object store), and the O1 owner prompt. **No migration this
session** — `file_metadata` (migration 0001) is used exactly as frozen; no new
columns, no new tables.

The rule above all others here: **the file source is a thin orchestrator; it
forks nothing.** A document's extracted text enters the same six pipeline
stages as a note; its bytes and metadata live in the memory module; its
deletion is the existing saga, unchanged.

## Ruling 1 — PDF via `pdf-parse`, DOCX via `mammoth`

Extraction (`connectors/document-extract.ts`) routes on the resolved content
type: PDF → **`pdf-parse` v2** (`new PDFParse({ data }).getText()`, joining
`result.pages[].text` — never `result.text`, which interleaves `-- N of M --`
page markers), DOCX → **`mammoth.extractRawText`**. Both take the bytes in
memory (the worker already holds them).

`pdf-parse` chosen over importing `pdfjs-dist` directly: it is a thin,
maintained wrapper over Mozilla's pdf.js that exposes a Buffer API and ships
CommonJS types, so it drops into the tsc CommonJS build with no ESM-interop
friction (pdfjs v4 is ESM-only; dynamic `import()` transpiles to `require()`
under `module: CommonJS` and breaks). New dependencies were authorised by the
O1 prompt naming both libraries.

**A parse failure is permanent and must fabricate nothing** (§B.3): the
extractor throws `PermanentExtractionError`, the pipeline job dead-letters, and
the file's status reads `error`. Zero memories, never a hallucinated one.
File pipeline jobs enqueue with `maxAttempts: 3` (notes keep the default 10) so
a corrupt document reaches its error state promptly while a transient
object-store blip still retries. (A permanent error still consumes those few
attempts — error-type-aware retry control is a future refinement.)

## Ruling 2 — Transactional ingestion: object-first, metadata-commit gating

Per the handoff's safe order (`connectors/files.service.ts`):

1. Mint the object key `{orgId}/{userId}/{scope}/file-{uuid}` (org id first,
   never a constant) and PUT the bytes to MinIO.
2. In ONE transaction: insert `file_metadata` (through the memory port) AND
   enqueue the pipeline job via `withTransactionalEnqueue`.
3. If that transaction aborts, the object is a true orphan → a compensating
   `deleteObject` removes it (abort-window cleanup).

A hard crash between (1) and (2) can leave a stray object, but with no
`file_metadata` row and no receipt referencing it the nightly sweep is blind to
it by construction — the same property discard-mode staging relies on. The
derived memories inherit the upload's `scope` and `sensitive` flags (threaded
through `SourceItem`); provenance is `source_type='file'`, `source_id=<object
key>`, so the saga enumerates them by provenance exactly as for notes.

## Ruling 3 — Filename + content type live on the object, not in a new column

`file_metadata` is frozen (handoff §5: no new columns). The original filename
and content type are stored as the MinIO object's `Content-Type` and an
`x-amz-meta-original-filename` (URL-encoded) header. They are therefore **erased
with the bytes** when the saga deletes the object — no schema of their own, and
no orphaned filename surviving a "provable" deletion. The source drawer reads
them back via a HEAD (`statObject`); the reader picks its parser from the
stored content type (with a magic-byte sniff as fallback and defence in depth).

## Ruling 4 — Interface additions on the memory module (not new clients)

The file source touches memory-owned storage ONLY through the memory module's
public interface (handoff §5; §A.1 rule 2, 0003 ruling 2). Two additions:

- **`MemoryFileStore`** — a public port over `file_metadata` (`record` inside
  the caller's transaction; `get`). The upload writes the row here; the reader
  and drawer read it here. No other module touches the table.
- **`MemoryObjectStore`** gains `getObject`, `statObject`, `presignGetUrl`, and
  metadata/content-type on `putObject` — the existing minimal SigV4 client
  extended (signing arbitrary headers; offline query-string signing for
  presign). Still no SDK.

`createIngestionPipeline` was added to the ingestion barrel so non-Nest callers
(tests) assemble the pipeline without the stage classes leaking out of the
module — mirroring `createMemoryStore`.

## Ruling 5 — Signed download URLs, and the browser-reachability caveat

Downloads use a short-lived (default 300 s) SigV4 presigned GET URL (§A.9),
owner-gated: the owner always; a non-owner only for a **shared, non-sensitive**
file in their own org (the object key's org segment is the gate). A **sensitive
file never leaves its owner** (decision 0003).

SigV4 binds the signature to the URL's host. The signing origin is
`COGETO_S3_PUBLIC_URL` (defaults to the internal `COGETO_S3_URL`,
`http://minio:9000`), because the browser cannot reach the internal MinIO
hostname and the compose edge does not route MinIO publicly. **Enabling
browser downloads is an infrastructure decision for the owner** (expose MinIO
at a browser-reachable origin with the Host header preserved + `MINIO_SERVER_URL`,
then set `COGETO_S3_PUBLIC_URL`), recorded in the O1-A owner checklist. The URL
generation itself is verified correct end-to-end (in-network fetch → 200,
`Content-Disposition: attachment; filename=…`).

## Ruling 6 — `ConnectorsModule` is a global dynamic module

To carry the configurable upload knobs (cap, TTL) from validated config while
keeping "only entrypoints read the environment", `ConnectorsModule` becomes
`register(options)` and is marked `global` (like the memory/seam modules), so
the source readers/deletions it exports resolve into ingestion and memory
without those modules re-importing it. Registered once per process root.
