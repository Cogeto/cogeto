# Session S2-B — embed + store, reindex, evaluation

**Date:** 2026-07-03 · **Scope:** S2-B owner prompt. Closes Session 2; Session 3
(retrieval fusion, chat, dashboard) starts fresh.

## What shipped

### Embedding through the gateway

- `ModelGateway.embed()` real against Mistral's embeddings API: batched (128
  inputs/request), typed retryable errors, per-batch length verification.
- Embed model via `MISTRAL_EMBED_MODEL` / `COGETO_MISTRAL_EMBED_MODEL`, default
  `mistral-embed`; `embeddingModelId()` exposes it.
- Migration `0004_embedding_model.sql`: `memory.embedding_model` records which
  model produced each vector — reindex's re-embed trigger.
- Zod contract loosened deliberately: omitted-empty fields (entity arrays,
  condition, temporal) now default instead of failing the schema — found live
  when the model omitted an empty `projects` array. claim/kind/source_span stay
  strict.

### Qdrant, inside the memory module only (0003 ruling 2)

- `@qdrant/js-client-rest@1.14.0` (pinned to the server version), imported ONLY
  in `memory/persistence/vector-store.ts`; dependency-cruiser rule
  `only-memory-imports-qdrant` enforces it. Non-Nest callers compose via
  `createMemoryStore()` / `reindexMemories()` — primitives in, no Qdrant types out.
- One collection `memories` (cosine, 1024 for mistral-embed): point id = memory
  id; payload `owner_id, scope, status, sensitive, source_type, source_id,
  valid_until`; payload indexes on the gate fields. Creation idempotent on
  worker boot (`memory vector collection ready`).
- **Stage 5 real** (decision 0005 ruling 1, supersedes 0004 ruling 1): batched
  embed → memory + verification_result rows in the job transaction → points
  last, upsert by memory id. A failed point write rolls back the rows and the
  job retries — one row, one point, never duplicates.
- **`vectorSearch(principal, embedding, opts)`** on the public interface: scope
  and sensitive gates as native Qdrant payload pre-filters (sensitive excluded
  by default, owner-only with explicit opt-in); scores normalized to [0,1].
  No fusion, no chat — Session 3.

### Reindex (§A.4)

`npm run reindex` (run inside the stack: `docker compose exec app npm run
reindex`): streams memories via keyset pagination, re-embeds only where the
stored `embedding_model` differs from the configured one or the point is
missing, reuses vectors otherwise, sweeps orphan points, verifies
`points == embeddable rows`, exits nonzero on mismatch. Documented in
`project/src/memory/README.md`.

### Golden set v0 + `npm run eval`

- 16 cases: `en-0001`–`en-0008`, `hr-0001`–`hr-0008` (fictional consultant
  persona; Croatian cases idiomatic, not translated). Covers: conditional
  commitments (en-0001, hr-0001, en-0008, hr-0007), relative dates (en-0003,
  hr-0003), multi-fact notes (en-0004, hr-0004), two nothing-to-remember cases
  (en-0005, hr-0002), two designed traps (en-0002, hr-0008).
- Harness (`ingestion/eval-harness.ts`): extract → verify live, semantic
  matching = embedding similarity + entity overlap, thresholds versioned in
  `project/eval/eval-config.json` (v1); per-case failures don't abort the run.
  Trap-case agreement rule documented in the harness header and decision 0005
  ruling 5. Results append to `docs/eval/history.md`. No CI gates yet (S4).

### First eval run (2026-07-03, extraction/v0001 + verification/v0001)

| set | cases | precision | recall | verification agreement |
|---|---|---|---|---|
| en | 8 | 92.9% | 100.0% | 57.1% |
| hr | 8 | 71.4% | 81.8% | 71.4% |
| **aggregate** | **16** | **82.1%** | **90.9%** | **64.3%** |

The low verification agreement is a genuine, valuable finding: the verifier
rules `partial` when the extractor has (correctly) resolved a relative date the
passage states only relatively. Belongs in `verification/v0002`; the baseline
is now measured. Details in `docs/eval/history.md`.

## Tests (all green)

| Test | Result |
|---|---|
| `two_store_write_safe` (ingestion) | pass — retried stage 5: one row, one point |
| `reindex_faithful` (memory) | pass — wipe → reindex → identical results; reuse and model-change paths asserted |
| `vector_search_gated` (memory) | pass — filter structure asserted AND behavior: B's private/sensitive never reach A |
| All S2-A + S1 suites | pass (20 tests + live-optional, which passes with a key) |

Full battery: lint, boundaries (126 modules, 0 violations), build, tests, and
`docker compose up` reaches login with all 7 containers healthy (migration 0004
applied by the init container).

## End-to-end proof (real stack, real Mistral)

1. Fresh note captured → pipeline `done` → memory `active` with
   `embedding_model: mistral-embed` and a Qdrant point.
2. `docker compose exec app npm run reindex` → `ok: true`, 9 points = 9
   embeddable memories (1 reused, 8 pre-S2-B rows backfilled).
3. `docker compose exec app npm run vector:smoke -- "what do I owe Maja before
   Thursday" owner-verify` → the fresh note's memory ranks first (0.817), all
   hits owner-visible only.

## Owner verification checklist

1. `docker compose up` → login; capture a note on **Memories**; it appears in
   the preview list (S2-A behavior intact).
2. `docker compose exec app npm run reindex` → report ends `reindex OK`.
3. `docker compose exec app npm run vector:smoke -- "<something you noted>"` →
   your memory ranks at the top; try a second user id to see the gates return
   nothing of yours.
4. `npm run eval` (host, key in `.env`) → metrics table prints and appends to
   `docs/eval/history.md`.
5. `docker compose logs worker | grep collection` → `memory vector collection
   ready` on every boot (idempotent).
