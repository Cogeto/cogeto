# model-gateway — seam (bounded context)

The swappable model seam (scope §5.1, Addendum §A.10). **All** LLM and embedding calls
in the system go through this interface — no direct provider SDK/API usage anywhere else.

v1 routes everything to the **Mistral API** (EU/zero-retention DPA terms). Behind the
same seam, sequenced by the Addendum: redaction mode is a CPU NER layer in front of
the API `[v1]` (§B.8); local embeddings + reranker `[v1.x]`; local utility LLM `[Later]`
(§A.10 — utility work only, never the user-facing answer).

The interface must be provider-neutral (complete / embed / rerank shapes), not a
wrapper around one vendor's types — swapping backends may not touch callers.

Owns: no domain tables. May depend on: nothing inside `src/` — this is a leaf seam.
All modules may depend on it.
