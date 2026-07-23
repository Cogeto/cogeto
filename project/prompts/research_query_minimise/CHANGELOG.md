# research_query_minimise — changelog

## v0002 — 2026-07-23 (Priority 6)

Hardens the subject rule against a live keep-subject miss observed on
`research_keeps_subject_hr` (the minimiser dropped "Adriatic Foods" from
"istraži tvrtku Adriatic Foods prije sastanka u četvrtak", leaving an
unanswerable "tvrtku prije sastanka"): the rule now states explicitly that a
"research company X" / "istraži tvrtku X" intent — with or without an occasion
attached — is ABOUT X (drop the occasion, never the name), and three few-shot
examples land the contrast (the en drop-the-client case, the hr keep-subject
case verbatim, and an en keep-subject case). Everything else verbatim from
v0001.

## v0001 — 2026-07-22 (Priority 5 Part B, decision 0044)

Initial version. Rewrites a proposed web search query to the least-identifying
form that still serves the research intent, before the show-edit-approve gate
(decision 0045). The subject rule: drop an entity that merely anchors a general
question; KEEP an entity that is itself the research subject; **when unsure,
keep it** — the user decides at the gate, so the conservative failure mode is
"asked the user", never "silently leaked" or "silently broke the search".
Output: `{ minimised_query, removed[], kept[], reason }` — the reason is the
one-line disclosure the gate shows. Same-language rule (never translate); runs
on the pipeline tier through the normal gateway (redaction-wrapped when that
profile is on). Live behaviour is exercised by the research chat-eval cases
(`research_minimise_drop`, `research_keeps_subject`).
