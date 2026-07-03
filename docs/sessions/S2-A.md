# Session S2-A — Notes capture, extraction, verification (pipeline stages 1–4)

**Date:** 2026-07-03 · **Scope:** S2-A owner prompt, sections 1–6. Embedding, Qdrant
and the eval harness are Prompt S2-B; reconciliation is Session 4.

## What shipped

### Capture (connectors)

- `note` table (migration `0003_notes_and_verification.sql`), owned by connectors.
- `POST /api/notes` — authenticated capture; note row + `note.captured` outbox event
  + `ingestion.pipeline` job commit in **one transaction** (§A.3).
- `GET /api/notes/:id` — owner-only source text (the source drawer).
- `GET /api/notes/:id/status` — `processing | done | failed`, derived from the
  `job_execution` idempotency row / `dead_letter` table (decision 0004 ruling 5).
- `NotesSourceReader` — implements ingestion's stage-1 `SourceReader` port.

### Pipeline (ingestion; worker-only)

One idempotent worker job per source item (`ingestion.pipeline`, key
`(source_type, source_id, job_type)`), all six glossary stages orchestrated by
`IngestionPipeline`, the whole run inside the job's idempotency transaction
(decision 0004 ruling 3):

1. **ingest** — via the `SourceReader` port (connectors implement; the worker
   composition root binds — decision 0004 ruling 2).
2. **chunk** — transient values, never rows; single chunk under 6 000 chars,
   length-based with 500-char overlap above it.
3. **extract** — `extractStructured` + Zod schema (claim, kind, entities, condition,
   temporal with `anchors_resolved`, exact `source_span`); malformed output throws →
   queue retry with backoff → dead-letter; nothing is ever stored from it.
4. **verify + admit** — one independent gateway call per fact; §B.3 admission:
   `supported` → `active`, `partial`/`unsupported` → `uncertain`; verdict, reason and
   prompt version stored in ingestion's `verification_result` table (migration 0003).
   Every memory carries owner, `scope='private'`, `sensitive=false`, provenance
   (`user_note`, note id) and resolved validity fields.
5. **embed + store** — stub (logs, passes through; S2-B adds batch embedding, the
   Qdrant point with payload gate copies, `content_embedding_ref` — 0004 ruling 1).
6. **reconcile** — stub (Session 4).

Logging: stage events and verdict **counts** only — never claims, spans or content.

### Prompts (§B.7)

| Family / version | sha256 (first 12) | Notes |
|---|---|---|
| `extraction/v0001` | `2d76b7f8bb43` | reference-time resolution, specificity, calibrated abstention (`{"facts": []}`) |
| `verification/v0001` | `2d1a643acf90` | independent auditor phrasing, no shared rubric; ties break downward |

Registered in `prompt_registry` on worker boot; a released file whose hash changed
fails the boot (immutability enforced).

### SPA

Memories nav section enabled (`/memories`): capture card ("Remember this...") with
optimistic clear + per-note processing indicator polling `/api/notes/:id/status`;
**Memories (preview)** list (placeholder for the S3 dashboard): content, status chip,
sensitive badge, source link opening the note in a drawer. `GET /api/memories` reads
through `MemoryStore` (scope + sensitive gates; explicit opt-in per 0003 ruling 3).

### Aggregate hardening (memory)

- Provenance guard **at the aggregate**: empty `owner_id`/`source_type`/`source_id`
  rejected on every write path (NOT NULL alone would accept empty strings).
- `admitExtractedFact(tx, …)` — the pipeline's admission path, committing with the
  job's idempotency row; creation audit actor is `verification`.
- `NewFact.validUntil` plumbed through.

### Structural decisions

Recorded in `docs/decisions/0004-s2a-pipeline-structure.md` (admission timing,
SourceReader port, in-transaction pipeline, global seam modules, queue-ledger status).

## Deferred / known gaps

- **Extracted entities are not persisted yet** — carried through the pipeline,
  dropped at admission; entity storage lands with retrieval's trigram work (S2-B/S3).
- Live-optional test asserts extraction + verification shape, not golden-set metrics
  (harness is S2-B).
- The status poll reports `done` for a `source_missing` skip — acceptable (nothing to
  show either way).

## Tests (all green; Testcontainers + scripted gateway at the ModelGateway seam)

| Test | Result |
|---|---|
| `capture_transactional` (connectors) | pass |
| `extraction_schema_guard` (ingestion) | pass |
| `admission_rule` (ingestion) | pass |
| `abstention` (ingestion) | pass |
| `provenance_always` (memory) | pass |
| `live_roundtrip` (live-optional) | **pass with real key** (skips without) |
| Pre-existing S1 suites (scope/sensitive gates, transitions, queue, config) | pass |

`npm run lint`, `npm run boundaries` (115 modules, 336 deps, 0 violations),
`npm run build` — clean. `docker compose up` reaches login; all 7 containers healthy;
migration 0003 applied by the init container.

## End-to-end verification (real stack, real Mistral)

Both fixtures captured through `NotesService` in the running compose stack:

- `en-0001` (canonical commitment) → 1 memory, `active`, verdict `supported`,
  condition preserved in the claim.
- `en-0002` (designed overreach) → discussion facts `active`; the extractor did
  **not** invent a decision; the inferred "will continue next week" claim was
  demoted to `uncertain` (verdict `unsupported`) — the §B.3 safety net working.

## Owner verification checklist

1. `docker compose up` on a fresh clone → login page.
2. Sign in, open **Memories**, paste fixture 1 (`project/eval/golden/en/en-0001-…/source.txt`):
   *"Send the revised proposal to Luka after he confirms the budget."*
   Expect: processing pulse → one **active** memory, condition intact, source link
   opens the note text in the drawer.
3. Paste fixture 2 (`en-0002-…/source.txt`, the Petra/Novira note). Expect: discussion
   facts active; **anything claiming a decision or an agreed €48,000 must wear the
   amber `uncertain` chip** (see the fixture's notes.md — that chip is the feature).
4. `docker compose logs worker` → two `prompt version registered` lines and
   per-note `ingestion pipeline completed` lines with verdict counts, no content.
5. `psql` (optional): `SELECT verdict, reason, prompt_version FROM verification_result;`
