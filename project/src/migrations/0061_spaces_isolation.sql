-- 0061: spaces, isolation in depth (V3 spaces session 2).
--
-- Decision record: docs/features/spaces.md. The foundation (0060) made the
-- space a hard gate on reads; this migration gives the COMPARISON machinery
-- and the aggregates their explicit partition columns, and prepares space
-- deletion. Everything here backfills in the same statement it alters, so
-- there is no orphan, no nullable remnant and no second pass, and a
-- single-space instance is byte-identical before and after.

-- ── The judged-pair ledger is space-aware ───────────────────────────────────
--
-- Two facts in different spaces are not a pair at all, so a ledger row's one
-- space is stamped at record time from the pair it judged. The uniqueness key
-- (a_memory_id, b_memory_id, family) is over globally unique memory ids, so a
-- coincidence in another space structurally cannot suppress a pairing here;
-- the column makes the ledger's partition explicit and its rows attributable.
-- Backfilled from a member's own space rather than trusting the DEFAULT,
-- because pairing has been space-scoped since 0060 and both members share
-- one space by construction.
ALTER TABLE checked_pair ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);
UPDATE checked_pair SET space_id = m.space_id
  FROM memory m WHERE m.id = checked_pair.a_memory_id;

-- ── Approvals are raised over one space's content ───────────────────────────
--
-- The approvals queue is a sidebar surface, and the record's sidebar is
-- space-scoped (docs/features/spaces.md section 3): an approval raised over
-- space A's content must not surface its summary, or be counted, in space B's
-- attention feed. Every pre-existing row is default-space material.
ALTER TABLE approval ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);

-- ── The two source-keyed badge ledgers carry the source's space ─────────────
--
-- Both are scanned per owner with a row limit to drive catalog badge filters
-- ('gated', 'truncated', 'unreadable'). Without the column the limit window
-- is consumed across spaces and the badge list silently under-reports; the
-- catalog's seal already prevented display, so this is a completeness fix,
-- not a disclosure one. file_read_report backfills from the file row it
-- describes; refusal rows are 30-day-pruned metadata and pre-existing rows
-- are default-space material.
ALTER TABLE extraction_gate_refusal ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);
ALTER TABLE file_read_report ADD COLUMN space_id uuid NOT NULL
  DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES space (id);
UPDATE file_read_report SET space_id = fm.space_id
  FROM file_metadata fm WHERE fm.object_key = file_read_report.object_key;

-- ── The audit trail records the space as an attribute ───────────────────────
--
-- Audit remains ONE instance-level, administrator-only trail (issue #633
-- decision, restated in the spaces record section 4); every audited action
-- about space content gains the space it happened in so an administrator can
-- filter by space. NULLABLE and deliberately WITHOUT a foreign key: an audit
-- entry outlives every space, including a deleted one, and a genuinely
-- instance-level action (provider configuration, user erasure, the nightly
-- sweep) has no space to name. NULL means instance-level, never "unknown".
ALTER TABLE audit_log ADD COLUMN space_id uuid;
CREATE INDEX audit_log_space_idx ON audit_log (space_id, created_at DESC);

-- ── Receipts outlive their space ────────────────────────────────────────────
--
-- A deleted space's receipts ARE the proof of its erasure and are immutable,
-- so the receipt table must not block DELETE FROM space. The column stays as
-- the chain key (each space's chain is walked from the receipts, never from
-- the space table); only the foreign key goes. Every OTHER space_id foreign
-- key keeps its NO ACTION behaviour on purpose: the final DELETE FROM space
-- refusing while any content row remains is the structural completeness proof
-- space deletion relies on.
ALTER TABLE deletion_receipt DROP CONSTRAINT deletion_receipt_space_id_fkey;

-- ── Machine-recorded revision links are re-homed ────────────────────────────
--
-- The import coordinator and the connector sync engine recorded detected
-- revision links without a space, so the row fell to the DEFAULT even when
-- both endpoints live elsewhere (the code stamps it from now on). Both paths
-- only ever link file successors, so the successor's file row names the one
-- space the link belongs to.
UPDATE source_revision SET space_id = fm.space_id
  FROM file_metadata fm
  WHERE source_revision.successor_type = 'file'
    AND source_revision.successor_id = fm.object_key;
