# retrieval — bounded context

Hybrid, fused, filtered search (Addendum §A.5): semantic vectors (Qdrant) + keyword
full-text (Postgres FTS) + entity match (trigram), fused with reciprocal rank fusion.

Binding rules:
- `scope` and `sensitive` are **hard gates** (WHERE-clause / Qdrant payload pre-filters
  inside the vector query — §A.4). App-side post-filtering of vector results is forbidden.
- Statuses are **score multipliers** on top of the gates (§A.5): active/user-approved ×1.0,
  uncertain ×0.6, contradicted ×0.4 with a visible warning, outdated ×0.2, replaced ×0.
- Temporal queries lift the outdated/replaced exclusion (§A.5, §B.2).

Owns: no tables — a query-side module over memory's public interface and Qdrant.
May depend on: `memory` public interface, `model-gateway` (query embeddings).

Read first: `docs/research/retrieval-and-pipeline-patterns.md`.
