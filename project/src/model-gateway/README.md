# model-gateway — seam (bounded context)

The swappable model seam (scope §5.1, Addendum §A.10). **All** LLM and embedding calls
in the system go through this interface — no direct provider SDK/API usage anywhere else
(dependency-cruiser rules + the grep-level `no_provider_leakage` test).

v1 routed everything to the **Mistral API** (EU/zero-retention DPA terms; still the
default). Post-v1 Priority 3 (decision 0040) added bring-your-own-key adapters —
**OpenAI-compatible** (base URL + key; also the doorway for a local runtime) and
**Anthropic** (no embeddings API — never eligible for the embeddings tier) — selected
per instance and per task tier by configuration, resolved and validated at boot by
`provider-config.ts`. Behind the same seam, sequenced by the Addendum: redaction mode
is a CPU NER layer in front of every provider `[v1]` (§B.8); local models via the
OpenAI-compatible adapter `[Priority 4]` (§A.10 — staged, eval-gated).

The interface must be provider-neutral (complete / embed / rerank shapes), not a
wrapper around one vendor's types — swapping backends may not touch callers.

Owns: no domain tables. May depend on: nothing inside `src/` — this is a leaf seam.
All modules may depend on it.
