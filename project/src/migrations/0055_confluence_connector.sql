-- 0055: the Confluence Cloud connector (V2.5 item 8.2) and the additive
-- platform columns the first real connector shakes out (decision record:
-- docs/features/confluence.md).
--
-- Platform additions (owned by `connectors`):
-- connector_sub_scope.settings_json: per-scope behaviour the user chooses,
-- today the attachments toggle; enforced before fetch, cheaper than any
-- gate. connector_sub_scope.stats_json: the honest backfill estimate the
-- worker computes, shown before anything runs. connector.presence_swept_at:
-- when the presence sweep last reconciled the ledger against what the
-- upstream still lists, because polling by modified date structurally
-- cannot observe an absence.
--
-- Gate additions (owned by `ingestion`): the reserved `folder` dimension is
-- activated (value = connector sub-scope key, stamped on the materialized
-- object), and a rule row may now carry its own fact budget and retention
-- so per-space policy is expressible; the tightest bound still wins.
--
-- confluence_page (owned by `confluence`): provenance for one materialized
-- source, page or attachment. Titles and space names are the document's own
-- words, so the row is content-bearing and joins the deletion cascade,
-- erased with its source. The ledger's arithmetic never carries any of it.

ALTER TABLE connector_sub_scope ADD COLUMN settings_json jsonb;
ALTER TABLE connector_sub_scope ADD COLUMN stats_json jsonb;
ALTER TABLE connector ADD COLUMN presence_swept_at timestamptz;

-- The sweep records its reconciliation as its own run kind, so the surface
-- can show it beside syncs; 0054's check predates the kind.
ALTER TABLE connector_sync_run DROP CONSTRAINT connector_sync_run_kind_check;
ALTER TABLE connector_sync_run ADD CONSTRAINT connector_sync_run_kind_check
  CHECK (kind IN ('backfill', 'incremental', 'webhook', 'presence'));

ALTER TABLE extraction_gate_rule ADD COLUMN fact_budget integer;
ALTER TABLE extraction_gate_rule ADD COLUMN retention_days integer;

CREATE TABLE confluence_page (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  org_id text NOT NULL,
  connector_id uuid NOT NULL,
  -- The materialized source this row describes (a `file` source today).
  source_type text NOT NULL,
  source_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('page', 'attachment')),
  -- The upstream identity: the page, and for attachments also the
  -- attachment id plus the page it hangs on.
  page_id text NOT NULL,
  attachment_id text,
  title text,
  space_key text,
  space_name text,
  version integer,
  -- The live page URL a fact links back to.
  url text,
  parent_page_id text,
  parent_title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX confluence_page_source_idx
  ON confluence_page (source_type, source_id);
CREATE INDEX confluence_page_owner_idx ON confluence_page (owner_id);
CREATE INDEX confluence_page_connector_idx ON confluence_page (connector_id);
