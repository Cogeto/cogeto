# prompts — versioned, published prompt artifacts

Every system prompt that decides what Cogeto remembers (extraction, verification,
dedup, contradiction, consolidation) lives here, governed by Addendum §B.7:

- **Versioned like migrations** — numbered, immutable once released, changelog required.
- **CI-evaluated** against the golden set (§B.4); the active version's eval score is
  recorded. Prompt changes that regress the golden set fail the build.
- **Public** — the exact prompt that decides what we remember, with measured accuracy.

Convention (finalize in the first coding session): one directory per prompt family,
numbered files, a CHANGELOG per family.

Consumed by `src/ingestion` and `src/tasks` via `model-gateway` calls.
