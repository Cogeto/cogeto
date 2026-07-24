# research_answer — changelog

## v0003 — 2026-07-24 (P6.6 instance context)

Instance context (decisions 0051/0052): the input may open with `NOW` (the
clock, not a source — for judging fetch-date freshness and relative time,
never cited) and `LANGUAGE` (the reply-language rule: mirror by default with
the preferred language as tie-breaker, always-preferred in strict mode,
question-language fallback without the line). Everything else verbatim from
v0002.

## v0002 — 2026-07-23 (Priority 6)

The instruction-vs-question rule: a research QUESTION phrased as an
instruction with an occasion attached ("research company X before Thursday's
meeting", "istraži tvrtku X prije sastanka") is answered ABOUT the subject —
the occasion says why the person is asking, never what information counts.
Targets a live miss on `research_keeps_subject_hr` where the synthesiser
declined ("no information about the company before Thursday's meeting") and
cited nothing despite on-subject sources. Everything else verbatim from
v0001.

## v0001 — 2026-07-22 (Priority 5 Part B, decision 0045)

Initial version. Synthesises a research answer on the answer tier from the
fetched pages of ONE approved research run plus optionally retrieved memories.
Per-claim provenance is the contract: `[W#]` markers for web claims (resolved
to URL + fetch time by the reader), `[M#]` markers for remembered facts
(resolved to memory citations), and a literal `(unsourced)` tag on anything
from model knowledge — the per-claim provenance rule, the same honesty split
chat answers make. Fetch-date qualification for time-sensitive claims ("as of
the fetch") mirrors decision 0043's temporal anchor.
