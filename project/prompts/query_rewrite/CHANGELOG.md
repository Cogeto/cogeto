# query_rewrite — changelog

The conversational query rewriter for the fast path (S3.5-B, F3; decision 0007
ruling 4). Resolves pronouns/ellipsis in a chat turn against recent turns into a
self-contained search query + entity list, so multi-turn questions ("who is
she?") retrieve their referent. Runs on the pipeline tier, bounded, with a
graceful fallback to the raw query on timeout/error.

## v0002 — 2026-07-05 (F3-A)

Adds temporal-intent classification (decision 0012 ruling 2): output gains
`temporal: null | { kind: previous | point_in_time | change_since, expression }`
with en + hr few-shots for each kind plus a "questions ABOUT time, not
questions that MENTION time" contrast (deadline-in-content → null). The model
copies date phrases VERBATIM into `expression`; the system resolves them
deterministically (S3.5 chrono resolver, past-preferring) — and discards any
temporal claim whose raw question lacks a temporal hint (the code-side veto
guard). Rewriting rules and the v0001 example unchanged.

## v0001 — 2026-07-03

Initial release. Strict JSON `{ rewritten_query, entities[] }`; never invents
entities absent from the turns; leaves already-self-contained questions
unchanged; one worked example (the Ana pronoun turn).
