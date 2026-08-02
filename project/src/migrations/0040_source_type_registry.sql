-- 0040: source types are registered, not enumerated in a database type
-- (spec §15.3; V2.0 item 3.6 part 3, closing boundary exception B16).
--
-- The `source_type` Postgres enum made the memory module the owner of the
-- source-type vocabulary: every new reader or connector cost a memory-owned
-- migration (ALTER TYPE ... ADD VALUE) on top of a hardcoded-switch edit across
-- six files, and a retired value (`calendar_event`, `task_conclusion`) could
-- never be dropped. The vocabulary now lives in the application's source-type
-- registry (`@cogeto/shared/src/source-types.ts`): one declaration per type,
-- carrying the metadata every consumer reads instead of switching on literals.
--
-- What this migration does:
--
--   1. `memory.source_type`           enum → text (values byte-identical)
--   2. `deletion_receipt.source_type` enum → text (values byte-identical)
--   3. drops the now-unreferenced `source_type` type
--
-- What it deliberately does NOT do:
--
--   * No CHECK constraint listing the values — that would re-enumerate the
--     vocabulary in the database, which is precisely what spec §15.3 forbids.
--     Validation moves to the registry boundary: the deletion saga rejects an
--     unregistered value at the API (as before), every internal producer is
--     typed with the registry's closed union, and the integrity sweep now
--     flags any row whose source_type the registry does not know — a state
--     the enum made impossible and manual SQL could otherwise create silently.
--   * No value rewrite of any kind. `deletion_receipt.source_type` feeds the
--     signed receipt chain's canonical payload as a STRING; the stored strings
--     are unchanged, so every historical receipt hashes and verifies exactly
--     as it did. The defunct values stay valid registry members forever for
--     the same reason.
--
-- Indexes (`memory_source_idx` on (source_type, source_id) and
-- `deletion_receipt`'s implicit accesses) are rebuilt by the column type
-- change; equality semantics over text are identical. Nothing orders by
-- source_type, so the enum's declaration-order collation is unobserved.
--
-- Reversibility: reversible while every stored value is a registered key,
-- which the registry boundary maintains. The reverse is:
--
--   CREATE TYPE source_type AS ENUM ('user_note','chat','email','calendar_event',
--     'file','task_conclusion','web','chat_conversation');
--   ALTER TABLE memory ALTER COLUMN source_type
--     TYPE source_type USING source_type::source_type;
--   ALTER TABLE deletion_receipt ALTER COLUMN source_type
--     TYPE source_type USING source_type::source_type;
--
-- (The recreated enum's member ORDER differs from the original's accreted
-- order — 0001 then 0025 then 0027 then 0031 — which is observable only via
-- enum comparison/ordering, which nothing uses.)

ALTER TABLE memory
  ALTER COLUMN source_type TYPE text USING source_type::text;

ALTER TABLE deletion_receipt
  ALTER COLUMN source_type TYPE text USING source_type::text;

DROP TYPE source_type;
