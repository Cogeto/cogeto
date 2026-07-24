# context_suggest — changelog

The confirmation pass of the derived-context suggestion loop (P6.6, decision
0053). Deterministic rules extract candidate company/role values from the
user's own memories; this pipeline-tier call only confirms or rejects them —
it never proposes values of its own. Conservative by contract: unsure means
rejected.

## v0001 — 2026-07-24 (P6.6 instance context)

Initial version. Strict JSON `{ company, role_title }` with per-candidate
`confirmed` booleans; confirmation requires the excerpts to state the value
about the user themself, as current, unambiguously.
