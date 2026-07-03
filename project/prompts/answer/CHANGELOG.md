# answer — changelog

Prompt family for the fast-path chat answerer (S3-A): answers only from the
retrieved fact blocks, cites with inline `[F#]` markers, says plainly when the
facts do not cover the question.

## v0001 — 2026-07-03

Initial release. Grounding rules (facts-only, no invention, honest gaps +
capture suggestion), mandatory inline markers, status and validity caveats in
prose, answer in the question's language.
