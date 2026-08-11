-- 0054: the connector platform (V2.5 item 8.1).
--
-- Six tables owned by the new `connectors` context and one owned by
-- `identity`. No external service is integrated by this unit; these are the
-- foundations every future connector inherits (decision record:
-- docs/features/connectors.md).
--
-- connector: the configured connector instance and its lifecycle state.
-- Removal TOMBSTONES the row (name cleared, the import_item precedent),
-- because the item ledger anchors to it; credentials, cursors, sub-scopes,
-- deliveries and rate state are destroyed, and already-ingested sources
-- remain with their provenance intact -- deleting a connector must not
-- silently erase memory.
--
-- connector_item: the natural-key ledger, the financially consequential
-- table. The uniqueness constraint on (connector_id, natural_key) is what
-- makes "the same upstream item became two sources" unrepresentable, and the
-- content hash beside it is what makes an unchanged item cost zero model
-- calls on reappearance. Deliberately carries identifiers and arithmetic
-- only, never content (no names, no titles, no excerpts), so it can survive
-- source deletion as dedup arithmetic: the cascade clears source_id and
-- marks the row erased, and an erased item is never re-materialized.
--
-- connector_credential (identity): sealed credential material under
-- COGETO_MASTER_KEY, the provider-key mechanism reused (the secret-box moved
-- to infrastructure; one mechanism, two sealed columns, each opened in
-- exactly one place). Scopes granted and the account identity are plaintext
-- beside it: what the user is entitled to see. The webhook signing secret is
-- NOT here: the app-side ingress must verify signatures and the credential
-- opener is worker-only, so that one secret is sealed on the connector row.

CREATE TABLE connector (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  org_id text NOT NULL,
  -- The descriptor registry key (e.g. 'reference'). Stable, never renamed.
  kind text NOT NULL,
  -- The user-chosen display name. Cleared to NULL on removal (tombstone).
  name text,
  state text NOT NULL DEFAULT 'configured'
    CHECK (state IN ('configured', 'authorised', 'syncing', 'healthy',
                     'degraded', 'needs_reauth', 'disabled', 'removed')),
  -- Non-secret settings: backfill bounds, per-connector item caps.
  settings_json jsonb,
  -- The webhook signing secret, sealed with the instance master key
  -- (v1.<iv>.<tag>.<ciphertext>). Selected in exactly one function,
  -- asserted structurally by webhook-secret-confinement.spec.ts.
  webhook_secret text,
  -- When the upstream webhook subscription expires; NULL = none or n/a.
  -- The maintenance job renews ahead of this and degrades to polling when
  -- renewal fails, never silently stopping.
  webhook_expires_at timestamptz,
  -- Operator-facing reason for degraded / needs_reauth, owner-gated domain
  -- detail (never in audit_log).
  status_reason text,
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connector_owner_idx ON connector (owner_id, created_at);
CREATE INDEX connector_state_idx ON connector (state);

CREATE TABLE connector_sub_scope (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id uuid NOT NULL REFERENCES connector(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  -- The upstream container's stable key (mailbox id, channel id, folder id).
  key text NOT NULL,
  -- The upstream's display label at discovery time. Rows are deleted
  -- outright on connector removal, so no tombstone is needed here.
  label text,
  -- The email-allowlist shape: nothing outside the selection is ever
  -- fetched. Discovery offers; the user selects; false is the default.
  selected boolean NOT NULL DEFAULT false,
  -- Whatever opaque token, timestamp or sequence the upstream provides.
  -- Persisted after every processed page so a sync resumes, never restarts.
  cursor_json jsonb,
  -- Bounded-backfill progress for this sub-scope (window, items done,
  -- complete flag). Incremental sync is the steady state after it.
  backfill_json jsonb,
  -- Per-sub-scope daily item cap override; NULL = the connector's own.
  item_cap integer CHECK (item_cap IS NULL OR item_cap > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX connector_sub_scope_key_idx
  ON connector_sub_scope (connector_id, key);

CREATE TABLE connector_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id uuid NOT NULL REFERENCES connector(id),
  owner_id text NOT NULL,
  -- The upstream identifier, container-independent by contract: the same
  -- item in two sub-scopes yields the same key and therefore ONE source.
  natural_key text NOT NULL,
  -- sha256 of the fetched content; equal hash = skip before any model call.
  content_hash text,
  -- Sub-scope keys this item has been seen in (identifiers, not labels).
  sub_scopes jsonb,
  -- The materialized source. Cleared when the source is erased by the
  -- deletion saga (a dangling provenance reference may not outlive a
  -- receipt); the row then reads 'erased' and is never re-materialized.
  source_type text,
  source_id text,
  -- The scope the item materialized under (its structural visibility mapping
  -- at first sight, spec 4.4.4). A later container move that would imply a
  -- DIFFERENT scope is reported in the sync summary, never silently
  -- re-stamped.
  materialized_scope text,
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'deleted_upstream', 'erased', 'failed')),
  -- Reason code for failed items; never content.
  reason text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- Last time the content hash changed (an upstream edit became a revision).
  changed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX connector_item_natural_key_idx
  ON connector_item (connector_id, natural_key);
CREATE INDEX connector_item_source_idx ON connector_item (source_type, source_id);

CREATE TABLE connector_sync_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id uuid NOT NULL REFERENCES connector(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('backfill', 'incremental', 'webhook')),
  state text NOT NULL DEFAULT 'running'
    CHECK (state IN ('running', 'completed', 'failed', 'cancelled')),
  -- The honest numbers: fetched, new, unchanged-skipped, revisions,
  -- moved, deleted upstream, skipped-restricted (spec 4.4.4), failed,
  -- cap-paused. Written as the pass advances; every number is real.
  counts_json jsonb,
  -- Failure/pause reason code; never content.
  reason text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX connector_sync_run_connector_idx
  ON connector_sync_run (connector_id, started_at DESC);

CREATE TABLE connector_webhook_delivery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id uuid NOT NULL REFERENCES connector(id) ON DELETE CASCADE,
  -- The provider's delivery/event identifier: the dedup key. A duplicate
  -- delivery hits the unique index, acknowledges 200 and does nothing.
  event_id text NOT NULL,
  -- Identifiers extracted from the VERIFIED payload: the item's natural key
  -- and sub-scope hint. Signals only, never content -- the processor fetches
  -- the item from the upstream through the normal outbound path, so webhook
  -- content never reaches a model.
  item_ref_json jsonb,
  state text NOT NULL DEFAULT 'received'
    CHECK (state IN ('received', 'processed', 'failed')),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE UNIQUE INDEX connector_webhook_event_idx
  ON connector_webhook_delivery (connector_id, event_id);
CREATE INDEX connector_webhook_received_idx
  ON connector_webhook_delivery (received_at);

CREATE TABLE connector_rate_limit (
  connector_id uuid NOT NULL REFERENCES connector(id) ON DELETE CASCADE,
  -- 'connector' for the per-connector bucket, 'account:<identity>' for the
  -- per-account bucket.
  bucket text NOT NULL,
  tokens double precision NOT NULL,
  refilled_at timestamptz NOT NULL DEFAULT now(),
  -- The wall the upstream named (Retry-After / 429). The next attempt waits
  -- for the LATER of refill and this; backoff never retries into the wall.
  retry_after_until timestamptz,
  PRIMARY KEY (connector_id, bucket)
);

CREATE TABLE connector_credential (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  org_id text NOT NULL,
  -- The connector this credential belongs to. A provenance-style reference,
  -- not a foreign key: the table is identity's and connector is another
  -- module's table (the source_revision precedent).
  connector_id uuid NOT NULL,
  -- The sealed material: access token, refresh token and provider extras as
  -- one JSON envelope, v1.<iv>.<tag>.<ciphertext> under COGETO_MASTER_KEY.
  -- Selected in exactly one function (identity's credential store), opened
  -- only by the worker-root-only opener; asserted structurally by
  -- credential-confinement.spec.ts.
  secret text NOT NULL,
  -- What the user is entitled to see, in plaintext beside the sealed column.
  account_identity text,
  scopes jsonb,
  expires_at timestamptz,
  last_refreshed_at timestamptz,
  -- Set when a refresh fails; the connector moves to needs_reauth rather
  -- than retrying forever.
  refresh_failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX connector_credential_connector_idx
  ON connector_credential (connector_id);
CREATE INDEX connector_credential_expiry_idx
  ON connector_credential (expires_at);
