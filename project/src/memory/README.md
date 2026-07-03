# memory — core domain (bounded context)

The `Memory` aggregate and everything that makes memory trustworthy: the memory and
`file_metadata` tables (schema: Addendum §A.6), status transitions (§A.1 rule 4: only
reconciliation sets `contradicted`, only the user sets `user-approved`, only the deletion
saga hard-deletes), validity intervals (§B.2), the **deletion saga + receipts** (§A.7,
§B.1), and the `reindex` command that rebuilds Qdrant from Postgres (§A.4).

Owns: memory, file_metadata, and deletion-receipt tables. Postgres is the source of
truth; Qdrant is a rebuildable index (§A.4).

May depend on: `model-gateway` (embeddings), `identity` (principals). Everyone else
reaches memory only through its public interface or domain events — never its tables
**and never the Qdrant client** (0003 ruling 2; dependency-cruiser rule
`only-memory-imports-qdrant`).

## Vector index (S2-B)

One Qdrant collection, `memories` (cosine, size per the embed model): point id =
memory id; payload carries `owner_id`, `scope`, `status`, `sensitive`,
`source_type`, `source_id`, `valid_until` with payload indexes on the gate fields.
`MemoryStore.vectorSearch(principal, embedding, opts)` applies the scope and
sensitive gates as native payload filters inside the query — never app-side.
`memory.embedding_model` records which model produced each vector.

## Reindex

Rebuilds Qdrant entirely from Postgres — the disaster-recovery and
embed-model-migration path (§A.4). Idempotent; re-embeds **only** rows whose
stored `embedding_model` differs from the configured one (or whose point is
missing), reuses existing vectors otherwise, sweeps orphan points, then verifies
`point count == embeddable memories` and **exits nonzero on mismatch**:

```sh
docker compose exec app npm run reindex     # or: worker
```

Change the embed model by setting `MISTRAL_EMBED_MODEL` (or
`COGETO_MISTRAL_EMBED_MODEL`) and running reindex.

Read first: `docs/research/memory-architecture-patterns.md`,
`docs/research/temporal-knowledge-patterns.md`.
