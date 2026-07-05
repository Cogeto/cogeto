-- Migration 0010 — nightly integrity sweep + receipt permanence (Session F1-B,
-- Addendum §A.7 step 4, §B.1; decision 0009).

-- ── integrity_alert: one row per discrepancy the sweep finds ──────────────────
-- kind: memory_row_present | qdrant_point_present | object_present | chain_broken
-- detail: the offending identifier (memory id / point id / object key) or the
-- chain error. The expression unique index makes re-detection idempotent: the
-- same discrepancy found on every nightly run stays ONE alert row.

CREATE TABLE integrity_alert (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id  uuid REFERENCES deletion_receipt (id),
  kind        text NOT NULL,
  detail      text NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX integrity_alert_dedupe_idx
  ON integrity_alert (coalesce(receipt_id::text, ''), kind, detail);

-- ── deletion_receipt permanence (§B.1: receipts cannot be deleted) ────────────
-- Enforced in the database, not by convention (the audit_log pattern): DELETE
-- never; UPDATE only while pending (the saga's one legal transition writes
-- hash/signature/timestamps as it flips pending → confirmed). A confirmed
-- receipt is frozen — the hash chain guards against tampering by anyone strong
-- enough to disable this trigger.

CREATE FUNCTION deletion_receipt_freeze() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'deletion receipts are permanent (§B.1)';
  END IF;
  IF OLD.status = 'confirmed' THEN
    RAISE EXCEPTION 'a confirmed deletion receipt is immutable (§B.1)';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER deletion_receipt_freeze_trigger
  BEFORE UPDATE OR DELETE ON deletion_receipt
  FOR EACH ROW EXECUTE FUNCTION deletion_receipt_freeze();
