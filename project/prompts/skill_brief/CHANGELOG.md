# skill_brief — changelog

- **v0002** (2026-07-30, audit 2.0 SEC-4): the data-fence clause, otherwise identical
  to v0001. Memory claims and fetched-page title/body are fenced; markers, url and
  fetch date stay outside.
## v0001 — 2026-07-25 (Priority 7, decision 0059)

Initial version. Synthesises the research-brief skill's brief on the answer
tier — the only skill stage that uses it. The structured brief (who they are;
what you already know; what is new or changed; contradictions and open
questions; talking points) carries per-claim provenance in the research
grammar: `[M#]` for remembered facts, `[W#]` for fetched pages (resolved to
URL + fetch time by the reader), a literal `(unsourced)` tag on model
knowledge. Contradiction surfacing is REQUIRED — a tension between a web
finding and a stored memory is stated, never silently resolved (decision 0059
ruling 6). The brief is Cogeto-initiated, so the LANGUAGE line anchors to
preferred_language (decision 0052).
