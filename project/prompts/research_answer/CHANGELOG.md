# research_answer — changelog

## v0001 — 2026-07-22 (Priority 5 Part B, decision 0045)

Initial version. Synthesises a research answer on the answer tier from the
fetched pages of ONE approved research run plus optionally retrieved memories.
Per-claim provenance is the contract: `[W#]` markers for web claims (resolved
to URL + fetch time by the reader), `[M#]` markers for remembered facts
(resolved to memory citations), and a literal `(unsourced)` tag on anything
from model knowledge — the per-claim provenance rule, the same honesty split
chat answers make. Fetch-date qualification for time-sensitive claims ("as of
the fetch") mirrors decision 0043's temporal anchor.
