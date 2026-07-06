# Session O1-A — File upload + the document pipeline

**Model:** Opus 4.8 (first Opus/executor session). **Implements against:** the
frozen F1 handoff (`docs/handoff/F1-deletion-saga.md`) and Addendum
§A.6/§A.9/§A.3/§B.3. **Decision:** `docs/decisions/0014-file-upload-and-extraction.md`.
**Migration:** none (`file_metadata` used exactly as frozen — no new columns).

O1-A is the file-upload + extraction slice of the roadmap's O1. The rest of O1
(approval state machine, audit-log reader/UI, extract-and-discard mode, minimal
Settings) is **not** in this session's prompt and is left for O1-B.

## What shipped

1. **Upload endpoint + storage** (`connectors/files.service.ts`,
   `files.controller.ts`, `document-upload.interceptor.ts`). `POST /api/files`
   (multipart, authenticated): validates type (PDF/DOCX, by declared MIME +
   magic-byte sniff) and size (configurable, default 25 MiB, enforced by multer
   with the injected cap), streams to MinIO under
   `{orgId}/{userId}/{scope}/file-{uuid}`, and writes `file_metadata` in the
   same transaction as the outbox enqueue. Scope selector defaults to `private`;
   `sensitive` is a checkbox. Original filename + content type ride on the MinIO
   object's metadata (no new column; erased with the bytes).
2. **Text extraction** (`connectors/document-extract.ts`): PDF via `pdf-parse`,
   DOCX via `mammoth`; clean text → the existing chunker → the SAME pipeline
   (extract → verify → embed+store → reconcile). Derived facts carry
   `source_type='file'`, `source_id=<object key>`, and inherit the upload's
   `scope`/`sensitive`. Parse failure → `error` state, zero memories.
3. **Upload UI** (`web/src/components/UploadCard.tsx`, `Memories.tsx`,
   `SourceDrawer.tsx`): drag-or-select beside the capture card, type/size
   validation, scope + sensitive controls, a per-file processing indicator
   polling job status, and a file source drawer with the filename, a signed-URL
   download, the extraction status, and the F1 delete affordance.
4. **Deletion** — unchanged: a file source is deleted through the existing
   `/api/sources/file/:id` saga. The cascade test is extended to a real uploaded
   file (below).

## Decisions the prompt asked me to record

- **PDF library: `pdf-parse` v2** (not `pdfjs-dist` directly). It is a thin,
  maintained pdf.js wrapper with a Buffer API and CommonJS types, so it drops
  into the `module: CommonJS` tsc build with no ESM-interop friction (pdfjs v4
  is ESM-only and would break dynamic `import()` under CommonJS). Text is joined
  from `result.pages[]`, not `result.text` (which injects `-- N of M --` page
  markers). DOCX via `mammoth.extractRawText`. Both authorised by the prompt.
- **Transactional order: object-first, metadata-commit gating.** PUT bytes →
  one transaction {`file_metadata` insert + outbox enqueue} → on abort, a
  compensating `deleteObject` removes the orphan. A hard crash between the PUT
  and the commit can leave a stray object, but with no metadata row and no
  receipt referencing it, the sweep is blind to it by construction. Detail in
  decision 0014 ruling 2.

## Test results (full battery)

- **`npm run build`** (shared + server + web): green.
- **`npm run lint`** (eslint + prettier): green.
- **`npm run boundaries`** (dependency-cruiser): green (221 modules).
- **Vitest**: **116 passed, 1 skipped** (the live-model spec, needs API keys) —
  6 new tests this session. (Run with `--no-file-parallelism`; a fully parallel
  run can flake on Testcontainers startup contention, not a code issue.)
  New this session:
  - `connectors/files.integration.spec.ts` — `upload_transactional` (happy path
    + aborted store leaves no metadata/job/object, orphan cleaned),
    `file_pipeline_parity` (PDF **and** DOCX: real extracted text reaches stage
    3, facts verify → active with file provenance, identical outcome to a note),
    `extraction_failure_safe` (corrupt PDF → `error` state, zero memories, no
    extraction), `signed_url_gated` (sensitive → owner-only; shared
    non-sensitive → org-shareable; other-org denied), `upload_type_rejected`.
  - `memory/upload-cascade.integration.spec.ts` — `deletion_cascade_upload`: a
    multi-fact **sensitive** upload → 3 memories/points + object + metadata →
    saga → all erased, receipt confirmed counting the object AND the memories,
    chain verifies, sweep clean.
- **`docker compose up` reaches login**: app + worker rebuilt in place and boot
  healthy; `FilesController` routes mapped; `/login` 200; all health checks
  green (postgres, qdrant, minio, SSE, integrity, migrations).

## Live end-to-end drill (compose stack, real OIDC login)

Scripted PKCE login as `admin@cogeto.localhost`, then over HTTPS through Caddy:

- `POST /api/files` (a generated PDF) → **201**, key
  `…/private/file-<uuid>`.
- `GET /api/files/:key/status` → **`done`** (real extraction + pipeline).
- `GET /api/files/:key` → filename `roadmap.pdf`, `application/pdf`, 630 B,
  `state: done` (filename read back from object metadata).
- `GET /api/files/:key/download` → presigned URL; fetched **inside the compose
  network** → **HTTP 200**, `application/pdf`,
  `Content-Disposition: attachment; filename="roadmap.pdf"`, 630 B.
- `GET /api/sources/file/:key/impact` → `{memoryCount:1, objectCount:1}`.
- `DELETE /api/sources/file/:key` → receipt; worker confirmed; `file_metadata`,
  memory, MinIO object and Qdrant point all gone; `state` → **404**.
- On-demand sweep after all drill churn: **8 receipts, 24 identifiers checked,
  0 alerts, chain ok**. Instance left clean (0 file rows/objects).

## MinIO console / DB checks (how to eyeball it)

- Objects: `docker compose exec minio sh -c "mc alias set local
  http://127.0.0.1:9000 cogeto cogeto-dev-password; mc ls --recursive
  local/cogeto"` — one `…/private/file-<uuid>` per stored upload; gone after
  deletion. Console at `http://localhost` MinIO (or `mc`); SSE-S3 is on.
- Rows: `docker compose exec postgres psql -U postgres -d cogeto -c "SELECT
  object_key, owner_id, scope, sensitive FROM file_metadata;"` and `… FROM
  memory WHERE source_type='file';`.

## Owner checklist (sign-off / decisions)

- [ ] **New dependencies** (authorised by the O1 prompt, recorded here):
      `pdf-parse`, `mammoth`, and `@types/multer` (dev). Confirm acceptance.
- [ ] **Browser downloads need an infra decision.** Presigned URLs are signed
      against `COGETO_S3_PUBLIC_URL` (defaults to the internal `http://minio:9000`,
      which browsers cannot reach — the compose edge does not route MinIO). To
      turn on downloads: expose MinIO at a browser-reachable origin (dedicated
      host/subdomain reverse-proxied to `minio:9000` with the Host header
      preserved, `MINIO_SERVER_URL` set to that origin) and set
      `COGETO_S3_PUBLIC_URL`. Alternative if you prefer no public MinIO:
      proxy downloads through the app. **URL generation is verified correct**;
      only the public route is missing. (0014 ruling 5.)
- [ ] **Interface additions on the memory module** (per handoff §5, surfaced for
      sign-off): `MemoryFileStore` (public port over `file_metadata`) and new
      `MemoryObjectStore` methods (`getObject`/`statObject`/`presignGetUrl` +
      metadata on `putObject`). No schema change; no new storage client.
- [ ] **`ConnectorsModule` is now a global `register(options)` module** (to
      carry the upload cap/TTL from config). Structural change to two composition
      roots — confirm.
- [ ] **Permanent-parse-error retries** consume a small budget (`maxAttempts: 3`
      for file jobs) before dead-lettering. Fine for v1; error-type-aware
      fast-fail is a possible refinement.
- [ ] Numbering: decision **0014** taken this session; no migration. Owner
      prompt numbering may lag — verify against the repo.

## STOP

O1-A complete. Next per roadmap: the rest of O1 (approval state machine +
gate test, audit-log reader/UI, extract-and-discard + minimal Settings) — O1-B.
