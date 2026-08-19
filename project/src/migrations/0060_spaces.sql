-- 0060: spaces, the foundation (V3 spaces session 1).
--
-- Decision record: docs/features/spaces.md, frozen (and amended) before this
-- migration. A SPACE is a fully sealed partition of the instance: everything
-- content-bearing lives inside exactly one space, no feature ever operates
-- across two, and two spaces relate to each other exactly like two separate
-- instances. The space is the GATE; the project stays the LENS
-- (docs/features/projects.md is untouched by this migration on purpose: no
-- ALTER TABLE here adds any project column anywhere, and project_assignment
-- keeps its global (ref_type, ref_id) uniqueness because a thing lives in one
-- space and at most one project).
--
-- space (owned by `spaces`): the partition record. The DEFAULT SPACE has a
-- fixed, well-known id so that a schema-level DEFAULT can name it: every
-- existing row is backfilled into it, and a single-space instance is
-- byte-identical to the product before this feature. It can be renamed like
-- any other space; it cannot be deleted while it is the only one (enforced in
-- code, where deletion will live).
--
-- user_space_state (owned by `spaces`): the user's last used space, resolved
-- on login and falling back to the default space. A pointer, not membership:
-- every instance user sees every space, by owner decision (record section 7).
--
-- space_id on every content-bearing ROOT: source roots (file_metadata, note,
-- email_message, web_page, confluence_page), memory, conversation, project,
-- research_run, skill_run, import_run, findings_report, connector,
-- source_context, entity_alias, suppressed_fact_log, source_revision,
-- passport_export, deletion_receipt. Child tables inherit through their root
-- where the join is natural (chat_message and chat_attachment through
-- conversation, verification_result and memory_relation through memory,
-- import_item through import_run, the connector children through connector,
-- email_attachment through email_message, skill_run_step through skill_run,
-- and the source-keyed ledgers through their source). The access-gate tables,
-- memory and suppressed_fact_log (and the Qdrant payload, in code), carry the
-- dimension DIRECTLY, because a gate that requires a join is a gate that will
-- eventually be bypassed.
--
-- The column is NOT NULL with a DEFAULT naming the default space, and the
-- DEFAULT is kept: it is the schema-level backstop that makes an UN-SPACED
-- row unrepresentable (a row always has a space; absent an explicit stamp it
-- is in the default space, which is a real space, never "all spaces").
-- Application write paths still stamp the caller's current space explicitly,
-- inside the same transaction that creates the source.
--
-- deletion_receipt.space_id makes the receipt chain PER SPACE (record
-- section 5 as amended): each space owns its own genesis, sequence and tip,
-- so a passport carrying one space's receipts is verifiable STANDALONE.
-- The column sits BESIDE the hashed payload, never inside it: the
-- canonicalisation and the signature format are untouched, the existing
-- chain becomes the default space's chain unchanged, and every historical
-- receipt verifies byte-identically.
--
-- Two uniqueness rules become per-space, because both name things a user may
-- legitimately repeat in another sealed partition: a project's name and an
-- entity-alias pair.
--
-- Reversal: DROP the two tables, every space_id column, and restore the two
-- replaced unique indexes from 0056 and 0048.

CREATE TABLE space (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The default space, with the fixed id the column DEFAULTs below name.
INSERT INTO space (id, name) VALUES ('00000000-0000-4000-8000-000000000001', 'Default');

CREATE TABLE user_space_state (
  user_id text PRIMARY KEY,
  last_space_id uuid NOT NULL REFERENCES space (id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Content-bearing roots. ADD COLUMN with a NOT NULL DEFAULT backfills every
-- existing row into the default space in the same statement: no orphan, no
-- nullable remnant, no second pass.
ALTER TABLE memory ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);
ALTER TABLE file_metadata ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);
ALTER TABLE note ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);
ALTER TABLE email_message ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);
ALTER TABLE web_page ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);
ALTER TABLE confluence_page ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);
ALTER TABLE conversation ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);
ALTER TABLE research_run ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);
ALTER TABLE skill_run ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);
ALTER TABLE import_run ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);
ALTER TABLE findings_report ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);
ALTER TABLE connector ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);
ALTER TABLE project ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);
ALTER TABLE source_context ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);
ALTER TABLE entity_alias ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);
ALTER TABLE suppressed_fact_log ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);
ALTER TABLE source_revision ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);
ALTER TABLE passport_export ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);
ALTER TABLE deletion_receipt ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);

-- The gate table's dimension is queried on every read; the receipt chain's
-- tip resolution walks confirmed receipts per space.
CREATE INDEX memory_space_idx ON memory (space_id);
CREATE INDEX deletion_receipt_space_idx ON deletion_receipt (space_id, status);

-- Per-space uniqueness: one "Client A" project per owner PER SPACE, and an
-- alias pair may recur across sealed partitions.
DROP INDEX project_owner_name_idx;
CREATE UNIQUE INDEX project_owner_name_idx ON project (owner_id, space_id, lower(name));
DROP INDEX entity_alias_owner_pair_idx;
CREATE UNIQUE INDEX entity_alias_owner_pair_idx
  ON entity_alias (owner_id, space_id, lower(canonical), lower(alias));
