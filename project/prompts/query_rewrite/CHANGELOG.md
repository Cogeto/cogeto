# query_rewrite — changelog

The conversational query rewriter for the fast path (S3.5-B, F3; decision 0007
ruling 4). Resolves pronouns/ellipsis in a chat turn against recent turns into a
self-contained search query + entity list, so multi-turn questions ("who is
she?") retrieve their referent. Runs on the pipeline tier, bounded, with a
graceful fallback to the raw query on timeout/error.

## v0001 — 2026-07-03

Initial release. Strict JSON `{ rewritten_query, entities[] }`; never invents
entities absent from the turns; leaves already-self-contained questions
unchanged; one worked example (the Ana pronoun turn).
