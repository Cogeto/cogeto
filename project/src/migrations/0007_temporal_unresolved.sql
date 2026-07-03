-- Migration 0007 — unresolved temporal expressions per memory (S3.5-A; F8).
-- Decision 0007 ruling 1: relative dates are resolved by deterministic code
-- from extractor-emitted raw expressions. When an expression cannot be
-- resolved, the validity fields stay null and the raw phrase is recorded here
-- so the memory detail drawer can flag "date could not be resolved".
-- Empty for every memory until extraction v0002 (S3.5-B) emits raw expressions;
-- additive and safe mid-session.

ALTER TABLE memory ADD COLUMN temporal_unresolved text[] NOT NULL DEFAULT '{}';
