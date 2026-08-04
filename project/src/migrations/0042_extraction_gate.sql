-- 0042: the per-source extraction gate (V2.1 item 4.3, spec 1.6).
--
-- Extraction becomes admission controlled per source and per connector: the
-- analogue of the first-person rule, applied one stage earlier. Where that rule
-- proved a cheap deterministic per-source predicate at one chokepoint beats
-- asking a model to be careful, the gate applies the same shape BEFORE the
-- model is spent at all, because the failure mode here is cost and corpus
-- flooding rather than a false claim. Without it, one bad folder floods the
-- corpus at full model cost the day bulk import (V2.2 item 5.3) and observed
-- connectors (V2.4 item 8.x) arrive.
--
-- Three tables, owned by ingestion (the module that enforces them):
--
-- extraction_gate: one row per (owner, source type). Absent row means today's
-- behaviour, byte-identical: enabled, registry fact budget, no retention. The
-- row only ever narrows.
--
-- extraction_gate_rule: allow/deny rows per (owner, source type, dimension,
-- value). Dimensions carried as plain text and validated in code, the
-- source-type-registry precedent (spec 15.3): today code binds
-- 'document_class' (the reading layer's detected format: pdf, docx, xlsx, csv,
-- image) and 'source_id' (one document switched off); 'channel' and 'folder'
-- are reserved for connectors and bulk import and need no migration when they
-- arrive. Email sender admission is NOT here: the email allowlist already owns
-- it and a second authority would let the two disagree.
--
-- extraction_gate_refusal: the honest ledger, mirroring email_refusal. A source
-- the gate blocked must not look processed-with-zero-facts, so each refusal is
-- one metadata-only row: which source, which reason, when. NEVER content, so
-- the 30-day retention prune (worker nightly) is hygiene rather than a deletion
-- promise; the rows still leave with their source through ingestion's cascade
-- because dangling provenance references are noise the sweep would have to
-- learn to ignore.

CREATE TABLE extraction_gate (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  source_type text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  -- NULL: the source-type registry's budget (and the global parse cap) decide.
  fact_budget integer CHECK (fact_budget IS NULL OR fact_budget > 0),
  -- NULL: facts live until their own validity or a status transition ends them.
  retention_days integer CHECK (retention_days IS NULL OR retention_days > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX extraction_gate_owner_type_idx
  ON extraction_gate (owner_id, source_type);

CREATE TABLE extraction_gate_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  source_type text NOT NULL,
  dimension text NOT NULL,
  value text NOT NULL,
  effect text NOT NULL CHECK (effect IN ('allow', 'deny')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX extraction_gate_rule_owner_idx
  ON extraction_gate_rule (owner_id, source_type, dimension, value);

CREATE TABLE extraction_gate_refusal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  reason text NOT NULL,
  -- The detected class the decision was made on, when a class rule made it.
  document_class text,
  refused_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX extraction_gate_refusal_owner_idx
  ON extraction_gate_refusal (owner_id, refused_at DESC);
CREATE INDEX extraction_gate_refusal_source_idx
  ON extraction_gate_refusal (source_type, source_id);
