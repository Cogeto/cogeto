# model-gateway: seam (bounded context)

The swappable model seam (scope §5.1, spec §12.1). **All** LLM and embedding calls
in the system go through this interface: no direct provider SDK/API usage anywhere else
(dependency-cruiser rules + the grep-level `no_provider_leakage` test).

v1 routed everything to the **Mistral API** (EU/zero-retention DPA terms; still the
default). Bring-your-own-key adapters were added later:
**OpenAI-compatible** (base URL + key; also the doorway for a local runtime) and
**Anthropic** (no embeddings API, never eligible for the embeddings tier), selected
per instance and per tier by configuration, resolved and validated at boot by
`provider-config.ts`. Behind the same seam, sequenced by the specification: redaction mode
is a CPU NER layer in front of every provider `[v1]` (spec §12.2); local models via the
OpenAI-compatible adapter `[Priority 4]` (spec §12.1, staged, eval-gated).

The interface must be provider-neutral (complete / embed / rerank shapes), not a
wrapper around one vendor's types, swapping backends may not touch callers.

Owns: no domain tables. May depend on: nothing inside `src/`. This is a leaf seam.
All modules may depend on it.
