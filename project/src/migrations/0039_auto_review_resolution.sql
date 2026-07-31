-- 0039: automatic review resolution and the suppressed-fact log (V2.0 item 3.3).
--
-- Cogeto stops asking the user to adjudicate facts. Unsupported, partial and
-- unjudgeable extractions are resolved at admission with no human step, and the
-- single undifferentiated `uncertain` bucket splits into named sub-reasons that
-- the V2.3 findings report renders.
--
-- Two schema changes and one backfill:
--
--   1. `uncertainty_reason` — the frozen sub-reason vocabulary, ONE Postgres
--      type used by both the memory column and the log table. An enum rather
--      than free text because "no outcome falls through to a default" then holds
--      at the database level, and because the vocabulary is frozen by design:
--      the expensive operation on an enum is REMOVING a value, which is exactly
--      what freezing it prevents.
--
--   2. `memory.uncertainty_reason` — why a memory is uncertain, NULL for every
--      other status. On the memory row rather than only inside ingestion's
--      `verification_result` because Sources and the report read facts through
--      the gated MemoryStore and ingestion's tables are module-private; without
--      it, rendering a reason costs one gated round-trip per fact.
--
--   3. `suppressed_fact_log` — every automatic decision that demoted or withheld
--      a fact: the claim as extracted, its exact span, the sub-reason, the
--      verification detail behind it, and the memory id when the fact WAS
--      admitted (NULL when it was not). Owner, scope and sensitive are inherited
--      from the source and gate reads exactly as they gate memories.
--
-- The backfill derives a sub-reason for existing `uncertain` rows only where the
-- stored verification result determines one, and marks the remainder
-- `legacy_unspecified` rather than guessing. No row is left without a reason and
-- no row gets an invented one.
--
-- Deletion: the log is content-bearing, so ingestion registers a DerivedCascade
-- and the deletion saga removes entries for every enumerated source, counting
-- them in the receipt (`suppressed_facts_removed`). The FK below is the safety
-- net for the admitted half; the by-source cascade is what covers the rest.

CREATE TYPE uncertainty_reason AS ENUM (
  'hedged_in_source',
  'partially_supported',
  'unsupported',
  'unjudgeable',
  'structurally_invalid',
  'legacy_unspecified'
);

-- Set at ADMISSION and never rewritten: it records why this fact was admitted
-- uncertain, which stays true after the status moves on (a fact the user later
-- confirms was still admitted for a reason, and the report says which). NULL
-- means the fact was never admitted uncertain. Deliberately NOT constrained
-- against `status`: statuses move (confirmation, contradiction and the lift that
-- restores a prior status), and a constraint tying the two would force this
-- immutable admission record to be rewritten by unrelated transitions.
ALTER TABLE memory ADD COLUMN uncertainty_reason uncertainty_reason;

CREATE TABLE suppressed_fact_log (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id              text NOT NULL,
  scope                 scope NOT NULL,
  sensitive             boolean NOT NULL DEFAULT false,
  source_type           text NOT NULL,
  source_id             text NOT NULL,
  fact_content          text NOT NULL,
  fact_kind             text,
  source_span           text NOT NULL,
  reason                uncertainty_reason NOT NULL,
  verification_verdict  verification_verdict,
  verification_reason   text,
  prompt_version        text,
  -- CASCADE, not SET NULL, and the distinction is load-bearing: `memory_id IS
  -- NULL` MEANS "this fact was never admitted". Nulling the column when a
  -- memory is erased would rewrite an admitted fact's history into a withheld
  -- one. It also closes the only memory hard-delete outside the saga (review
  -- rejection, spec §3): the entry holds the rejected extraction's content and
  -- span, so it must not outlive the row the user removed. The saga still
  -- deletes these rows EXPLICITLY and counts them, so the receipt is honest;
  -- this constraint is the safety net, exactly as it is for verification_result.
  memory_id             uuid REFERENCES memory(id) ON DELETE CASCADE,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX suppressed_fact_source_idx        ON suppressed_fact_log (source_type, source_id);
CREATE INDEX suppressed_fact_owner_created_idx ON suppressed_fact_log (owner_id, created_at);
CREATE INDEX suppressed_fact_reason_idx        ON suppressed_fact_log (reason);

-- Backfill, most specific first. Each statement excludes rows an earlier one
-- already set, so a memory is written exactly once.
--
-- `hedge_phrase` is only ever written when the extractor flagged the SOURCE as
-- tentative, so its presence is the recorded, unambiguous hedged case.
UPDATE memory m
   SET uncertainty_reason = 'hedged_in_source'
  FROM verification_result v
 WHERE v.memory_id = m.id
   AND m.status = 'uncertain'
   AND m.uncertainty_reason IS NULL
   AND v.hedge_phrase IS NOT NULL;

UPDATE memory m
   SET uncertainty_reason = 'partially_supported'
  FROM verification_result v
 WHERE v.memory_id = m.id
   AND m.status = 'uncertain'
   AND m.uncertainty_reason IS NULL
   AND v.verdict = 'partial';

UPDATE memory m
   SET uncertainty_reason = 'unsupported'
  FROM verification_result v
 WHERE v.memory_id = m.id
   AND m.status = 'uncertain'
   AND m.uncertainty_reason IS NULL
   AND v.verdict = 'unsupported';

-- Everything left: an uncertain row with no verification result at all, or one
-- whose verdict is `supported` with no recorded hedge phrase (pre-hedge-column
-- rows, where the reason genuinely cannot be recovered). Marked explicitly
-- rather than guessed.
UPDATE memory
   SET uncertainty_reason = 'legacy_unspecified'
 WHERE status = 'uncertain'
   AND uncertainty_reason IS NULL;
