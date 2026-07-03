# answer — changelog

Prompt family for the fast-path chat answerer (S3-A): answers only from the
retrieved fact blocks, cites with inline `[F#]` markers, says plainly when the
facts do not cover the question.

## v0002 — 2026-07-03 (S3.5-B)

Quality-hardening from owner testing. (F2) explicit "describe the world, not the
retrieval" — the words facts/records/referenced/on-record are forbidden in
user-visible text. (F1/F4) a `MODE` block and per-fact subject entity: in
`entity_profile` mode the answer opens with who the subject is and aggregates ALL
their facts; a fact ABOUT Ana that MENTIONS Marta describes Ana, and a
mentioned person is never presented as the asked-about person. (F6) the strict
`[F#]` marker rule with two few-shot examples and an explicit ban on `[F2, F4]`
grouping. (hedge display) uncertain facts are included with soft framing and
never stated as confirmed. Honest-gap / nothing-on-record behavior unchanged.
Runs on the answer tier (decision 0007 ruling 3).

## v0001 — 2026-07-03

Initial release. Grounding rules (facts-only, no invention, honest gaps +
capture suggestion), mandatory inline markers, status and validity caveats in
prose, answer in the question's language.
