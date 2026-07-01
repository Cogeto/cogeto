# memory — core domain (bounded context)

The `Memory` aggregate and everything that makes memory trustworthy: the memory and
`file_metadata` tables (schema: Addendum §A.6), status transitions (§A.1 rule 4: only
reconciliation sets `contradicted`, only the user sets `user-approved`, only the deletion
saga hard-deletes), validity intervals (§B.2), the **deletion saga + receipts** (§A.7,
§B.1), and the `reindex` command that rebuilds Qdrant from Postgres (§A.4).

Owns: memory, file_metadata, and deletion-receipt tables. Postgres is the source of
truth; Qdrant is a rebuildable index (§A.4).

May depend on: `model-gateway` (embeddings), `identity` (principals). Everyone else
reaches memory only through its public interface or domain events — never its tables.

Read first: `docs/research/memory-architecture-patterns.md`,
`docs/research/temporal-knowledge-patterns.md`.
