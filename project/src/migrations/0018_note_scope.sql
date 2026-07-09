-- Migration 0018 — scope on the note table (Session O2-B). Notes were
-- private-only in v1 (the embed-store stage hard-defaulted derived memories to
-- `private`); shared scope now ships to humans, so capture can choose. The note
-- row carries the chosen scope so the worker's source reader can pass it to the
-- pipeline (memories inherit source.scope). Additive; existing notes stay
-- private (the column default), matching their derived memories.

ALTER TABLE note
  ADD COLUMN scope scope NOT NULL DEFAULT 'private';
