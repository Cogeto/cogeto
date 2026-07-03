# 0005 — S2-B rulings (embedding, vector index, eval harness v0)

**Date:** 2026-07-03 · **Status:** accepted · **Governs:** where facts are persisted
in the pipeline, two-store write ordering, memory-module scoping of Qdrant, score
normalization, eval-harness v0 semantics. **Driven by:** the S2-B owner prompt.

## Ruling 1 — Persistence moves into stage 5 (supersedes 0004 ruling 1)

Stage 4 (verify) now only decides verdicts. Stage 5 (embed + store) embeds all
verified claims in one batched gateway call, writes the memory +
`verification_result` rows inside the job's idempotency transaction, and upserts
the Qdrant points **last**. This restores the glossary's "each verified fact is
embedded and persisted in the same step". The §B.3 admission rule is unchanged —
the verdict still decides `active` vs `uncertain`.

*Two-store safety:* rows are transactional, points are not. Point upsert is
idempotent by memory id; a failed point write rolls back the rows and retries the
job — never a duplicate row. Points written before an in-batch failure can survive
as orphans; they are unreachable (hits resolve through gated Postgres reads) and
are swept by `reindex` (and later the §A.7 nightly job). Postgres stays the truth.

## Ruling 2 — MemoryModule registers dynamically and globally; Qdrant stays private

`MemoryModule.register({ qdrantUrl, embeddingModel })` follows the DatabaseModule /
seam pattern (0004 ruling 4). The Qdrant client lives in
`memory/persistence/vector-store.ts` (module-private; dependency-cruiser rule
`only-memory-imports-qdrant`). Non-Nest callers compose via
`createMemoryStore(...)`/`reindexMemories(...)`, which take primitives only — no
Qdrant type crosses the module boundary. Tests outside the memory module assert
Qdrant state over plain REST, not the client.

## Ruling 3 — Embedding model identity

`memory.embedding_model` (migration 0004) records the producer of each vector;
`ModelGateway.embeddingModelId()` exposes the configured one
(`MISTRAL_EMBED_MODEL`, default `mistral-embed`). Reindex re-embeds exactly the
rows where the two differ or the point is missing. The pre-existing
`content_embedding_ref` column stays unused for now (S1 placeholder; the point id
is the memory id, so a separate ref adds nothing — revisit if a second collection
ever appears).

## Ruling 4 — Vector scores normalize at the adapter boundary

`vectorSearch` maps Qdrant cosine similarity from [-1,1] to [0,1]
(`(s+1)/2`, clamped), per the research contract "all scores normalized to [0,1],
higher = better" — fusion in Session 3 builds on this.

## Ruling 5 — Eval harness v0 semantics (no CI gates yet)

Matching = embedding cosine similarity ≥ threshold AND entity coverage ≥
threshold, greedy per expected label; thresholds versioned in
`project/eval/eval-config.json` (v1). Verification agreement:
`verification_expected: supported` cases agree when all matched facts verdict
`supported`; `unsupported` (trap) cases agree when no unmatched extracted fact was
admitted as `supported` (extractor abstention and verifier demotion both count as
correct trap handling). Session 4 turns the spec's CI gates on.
