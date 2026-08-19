-- 0063: spaces, the edges and the artifacts (V3 spaces session 4).
--
-- Decision record: docs/features/spaces.md section 6c. This session covers
-- the paths where content enters the instance without a person standing in a
-- space (inbound mail, machine callers) and the per-space read state the
-- earlier sessions deferred. Everything backfills in the statement that
-- alters, so every existing value lands in the DEFAULT space (migrated,
-- never reset), there is no orphan and no nullable remnant, and a
-- single-space instance is byte-identical before and after.
--
-- Reversal: drop the two new tables, drop the added columns, restore the
-- single-column primary key on attention_state and the two-column primary
-- key on attention_dismissal.

-- ── Email routing rules gain a space target ─────────────────────────────────
--
-- A sender allowlist entry now names the space its mail lands in. The column
-- DEFAULT keeps every existing rule routing exactly where it always did (the
-- default space). The foreign key stays NO ACTION: a routing rule dies with
-- its target space through the email cleanup leg (falling back to another
-- space would misfile a client's mail, the one forbidden outcome), and the
-- constraint is the loud mid-erasure backstop.
ALTER TABLE email_allowlist ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);

-- A per-owner alias rule: mail to the instance address plus-tagged with the
-- alias routes to the named space. An alias the recipient has not defined is
-- REFUSED, never defaulted (the sender named a partition explicitly).
CREATE TABLE email_alias (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   text NOT NULL,
  alias      text NOT NULL,
  space_id   uuid NOT NULL REFERENCES space (id),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX email_alias_owner_alias_idx ON email_alias (owner_id, alias);

-- ── Machine callers carry a space via a per-credential binding ──────────────
--
-- A machine principal (a token without a human profile) has no current space
-- and no "most recent" anything, so its space is a property of the
-- credential's identity: administrator-managed, one binding per machine
-- user. CASCADE with the space (the user_space_state precedent: a binding is
-- credential state about a space, never content), so a deleted space unbinds
-- the machine and the guard refuses it loudly instead of degrading anywhere.
CREATE TABLE machine_space_binding (
  user_id    text PRIMARY KEY,
  space_id   uuid NOT NULL REFERENCES space (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── The attention read state becomes per (user, space) ──────────────────────
--
-- The unread indicator compares feed items against ONE last-seen timestamp;
-- keyed by owner alone, opening the dashboard in one space silenced another
-- space's brand-new items, contradicting the record's "badges recompute on
-- switch". Existing rows become the default-space rows via the column
-- DEFAULT. CASCADE like every per-user preference row.
ALTER TABLE attention_state ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001'
  REFERENCES space (id) ON DELETE CASCADE;
ALTER TABLE attention_state DROP CONSTRAINT attention_state_pkey;
ALTER TABLE attention_state ADD PRIMARY KEY (owner_id, space_id);

-- Dismissals gain the column their key convention already encoded (6a gave
-- non-default spaces a space segment INSIDE the key string). The column makes
-- the space a real filter instead of a naming convention, so a forged key
-- can never suppress a line in a space the caller is not in. Existing rows
-- are default-space material by construction (their keys are the historical
-- two-segment form), which is exactly what the column DEFAULT states.
ALTER TABLE attention_dismissal ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001'
  REFERENCES space (id) ON DELETE CASCADE;
ALTER TABLE attention_dismissal DROP CONSTRAINT attention_dismissal_pkey;
ALTER TABLE attention_dismissal ADD PRIMARY KEY (owner_id, space_id, item_key);
