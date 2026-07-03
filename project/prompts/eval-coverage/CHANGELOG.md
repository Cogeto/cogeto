# eval-coverage — changelog

The coverage grader for the chat-answer eval suite (`npm run eval:chat`, S3.5-A):
given an assistant answer and a numbered list of expected facts, it returns a
per-fact covered/not-covered judgment. Versioned and immutable like every prompt
(§B.7); it grades eval output only and is never used in the product path.

## v0001 — 2026-07-03

Initial release. Per-fact coverage rubric: covered = the answer conveys the
fact's substance and entities (paraphrase allowed); hedging does not reduce
coverage; wrong-person attribution does not count.
