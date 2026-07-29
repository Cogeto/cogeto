-- Migration 0004 — embedding model identity per memory.
-- reindex must know when re-embedding is required: a memory embedded with a
-- different model than the configured one gets a fresh vector; matching ones
-- reuse the stored point (spec §4.2 — Qdrant is a rebuildable index).
-- NULL = not embedded yet (pre- rows, or rows created while stage 5 failed).

ALTER TABLE memory ADD COLUMN embedding_model text;
