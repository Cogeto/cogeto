-- Migration 0004 — embedding model identity per memory (S2-B).
-- reindex must know when re-embedding is required: a memory embedded with a
-- different model than the configured one gets a fresh vector; matching ones
-- reuse the stored point (§A.4 — Qdrant is a rebuildable index).
-- NULL = not embedded yet (pre-S2-B rows, or rows created while stage 5 failed).

ALTER TABLE memory ADD COLUMN embedding_model text;
