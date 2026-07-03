-- Migration 0006 — the verifier's cited span, persisted (S3-B).
-- The review queue shows the fact and the exact source passage side by side;
-- until now the span lived only in the transient extraction output. NULL for
-- pre-S3-B rows — the UI falls back to showing the whole source text.

ALTER TABLE verification_result ADD COLUMN source_span text;
