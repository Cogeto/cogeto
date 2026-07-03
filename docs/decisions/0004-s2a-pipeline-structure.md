# 0004 — S2-A structural rulings (pipeline, source-reader port, admission timing)

**Date:** 2026-07-03 · **Status:** accepted · **Governs:** ingestion pipeline shape,
connector↔ingestion dependency direction, when verified facts are persisted, seam
module scoping. **Driven by:** the S2-A owner prompt (which sanctions the deviations
recorded here).

## Ruling 1 — Admission persists at stage 4; "embed + store" stores the *vector*

The glossary says stage 5 ("embed + store") is where "each verified fact is embedded
and persisted in the same step". The S2-A prompt (§4) directs that facts are created
through the Memory aggregate **as part of the verification pass admission rule** —
so the Postgres row is written at stage 4, atomically with its
`verification_result` row and the job's idempotency row. Stage 5's job (S2-B) is the
embedding half: batch-embed admitted facts, upsert Qdrant points with payload gate
copies (§A.4), set `content_embedding_ref`.

*Rationale:* admission must commit with the verdict that earned the status (§B.3) —
deferring the row to stage 5 would let an embedding failure roll back an already-
earned admission. Postgres remains the source of truth; the vector is an index
artifact (§A.4).

## Ruling 2 — Ingestion owns a SourceReader port; connectors implement it

The pipeline's ingest stage reads source content through a `SourceReader` interface
defined in ingestion's public API. Connectors implement it (`NotesSourceReader`) and
the **worker composition root** binds implementations to the `SOURCE_READERS` token
(`IngestionModule.register({ imports, readers })`). Dependency direction is
one-way: connectors → ingestion (port + job-type constant); ingestion never imports
a connector, keeping the module graph acyclic (§A.1) and connector tables private
(rule 2).

## Ruling 3 — Pipeline job runs inside the idempotency transaction

The whole six-stage run for one source item executes inside the §A.3 idempotent-job
transaction, model calls included. Any failure — including model output that fails
the Zod schema — rolls back everything; retries/dead-letter come from the queue.
Trade-off: a DB connection is held during model calls; accepted at worker
concurrency 2 for note-sized sources, to be revisited for bulk connectors (email).

## Ruling 4 — Seam modules register as global Nest modules

`IdentityModule.register` and `ModelGatewayModule.register` are `global: true`
(mirroring `DatabaseModule`): the composition root registers each seam once with
its options; domain modules inject `BearerAuthGuard` / `ModelGateway` without
re-registration. Import rules are still enforced by dependency-cruiser, not by
Nest visibility.

## Ruling 5 — Note processing status is derived from queue ledgers

`GET /api/notes/:id/status` derives `processing | done | failed` from the
`job_execution` idempotency row and the `dead_letter` table — no extra status
column to keep consistent. "Done" therefore means "the pipeline job committed",
which is exactly what the dashboard needs to refetch memories.
