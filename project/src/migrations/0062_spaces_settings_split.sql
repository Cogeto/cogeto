-- 0062: spaces, the settings split (V3 spaces session 3).
--
-- Decision record: docs/features/spaces.md section 4. The rule: any setting
-- that influences what is extracted, stored, retrieved or answered is
-- space-scoped; identity, appearance and infrastructure are instance-scoped.
-- This migration gives the two settings families the record scopes per space
-- their partition column. Everything backfills in the statement that alters,
-- so every existing value lands in the DEFAULT space (migrated, never reset),
-- there is no orphan and no nullable remnant, and a single-space instance is
-- byte-identical before and after.
--
-- Reversal: drop the added columns, restore the single-column primary key and
-- the two unique indexes without space_id.

-- ── Capture and upload defaults become per user per space ───────────────────
--
-- The default scope and the extract-and-discard default shape what is STORED,
-- so they are sealed with the space: two users may hold different defaults in
-- one space, and one user may hold different defaults in two spaces. The
-- existing row (one per user) becomes that user's DEFAULT-space row via the
-- column DEFAULT, which is exactly the record's migrate-not-reset rule. The
-- foreign key CASCADES with the space (the user_space_state precedent):
-- a preference row is per-user state about a space, never content, so it is
-- not part of the structural completeness proof that keeps every content
-- foreign key NO ACTION.
ALTER TABLE user_settings ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001'
  REFERENCES space (id) ON DELETE CASCADE;
ALTER TABLE user_settings DROP CONSTRAINT user_settings_pkey;
ALTER TABLE user_settings ADD PRIMARY KEY (user_id, space_id);

-- The auto-research toggle moves server-side (it lived in browser
-- localStorage, one value per DEVICE, which contradicts the record's per-space
-- scope for research behaviour). false is the behaviour every instance had by
-- default; a device-local opt-in cannot be migrated from here and there are no
-- production instances to carry one.
ALTER TABLE user_settings ADD COLUMN auto_research boolean NOT NULL DEFAULT false;

-- ── The extraction gate is sealed with the space ────────────────────────────
--
-- Gate rows and rules decide what is EXTRACTED, so a rule written for one
-- space must not govern admission in another. Both uniqueness keys gain the
-- dimension: the same owner may now hold a different gate for the same source
-- type in two spaces, which is the point. Existing rows are default-space
-- material via the column DEFAULT. The foreign keys stay NO ACTION like every
-- content-adjacent table; space deletion removes these rows through the
-- ingestion cleanup leg, so the final DELETE FROM space keeps its structural
-- completeness proof.
ALTER TABLE extraction_gate ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);
DROP INDEX extraction_gate_owner_type_idx;
CREATE UNIQUE INDEX extraction_gate_owner_type_idx
  ON extraction_gate (owner_id, space_id, source_type);

ALTER TABLE extraction_gate_rule ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);
DROP INDEX extraction_gate_rule_owner_idx;
CREATE UNIQUE INDEX extraction_gate_rule_owner_idx
  ON extraction_gate_rule (owner_id, space_id, source_type, dimension, value);
