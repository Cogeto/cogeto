-- Migration 0021 — inbound email (Session O4, decision 0028). Feature tables
-- arrive with their feature (decision 0003 ruling 1). All four are owned by the
-- connectors module; memories extracted from an email carry provenance
-- source_type = 'email' (already in the source_type enum, migration 0001),
-- source_id = email_message.id (§A.6).
--
-- Full retention (decision 0028 ruling 5): the row + the raw MinIO object are
-- the complete retained message. Object keys are recorded on the row so the
-- deletion saga can enumerate and erase them (saga coverage is Unit B; the
-- schema is deletion-ready).

-- ── email_message: the retained inbound message (one per accepted email) ──────
CREATE TABLE email_message (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        text NOT NULL,
  -- Capture-time scope; derived memories inherit it (the source reader passes
  -- it to the pipeline). Default private, like notes (migration 0018).
  scope           scope NOT NULL DEFAULT 'private',
  -- Owner-only display of sensitive email content (decision 0003 flag).
  sensitive       boolean NOT NULL DEFAULT false,
  -- Threading headers, retained verbatim for future thread reconstruction.
  message_id      text,
  in_reply_to     text,
  "references"    text[] NOT NULL DEFAULT '{}',
  from_addr       text NOT NULL,
  to_addr         text NOT NULL,
  subject         text,
  sent_at         timestamptz,
  received_at     timestamptz NOT NULL DEFAULT now(),
  -- The complete original RFC822 in MinIO (scoped, SSE-encrypted key) — literal
  -- provenance; deletion removes it.
  raw_object_key  text NOT NULL,
  -- The text/plain body used for extraction (retained in full).
  text_body       text,
  -- The sanitised text/html body: stored inline when small, else in MinIO.
  html_body       text,
  html_object_key text,
  -- The full parsed header set (structural retention).
  headers_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
  has_attachments boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_message_owner_received_idx ON email_message (owner_id, received_at DESC);
CREATE INDEX email_message_message_id_idx ON email_message (message_id);

-- ── email_attachment: every attachment recorded; supported types linked to a
--    document-pipeline file source (decision 0028 ruling 8) ─────────────────────
CREATE TABLE email_attachment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id        uuid NOT NULL REFERENCES email_message (id) ON DELETE CASCADE,
  filename        text,
  content_type    text,
  size_bytes      integer NOT NULL DEFAULT 0,
  -- Supported document types (pdf/docx) are stored and enqueued as their own
  -- file source; this is that file source's object key (source_type 'file').
  -- NULL for unsupported attachments (recorded, not processed) — their bytes
  -- remain within the retained raw original.
  file_object_key text,
  processed       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_attachment_email_idx ON email_attachment (email_id);

-- ── email_allowlist: the primary acceptance gate (decision 0028 rulings 2/7) ──
-- Empty by default → no external mail accepted (closed by default). A message is
-- accepted only when its matched sender is an 'address' entry or matches a
-- 'domain' entry. Values are stored normalized (lower-cased; domains bare).
CREATE TYPE email_allowlist_kind AS ENUM ('address', 'domain');

CREATE TABLE email_allowlist (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   text NOT NULL,
  kind       email_allowlist_kind NOT NULL,
  value      text NOT NULL,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One entry per (owner, kind, value): adding an existing entry is a no-op.
CREATE UNIQUE INDEX email_allowlist_owner_kind_value_idx
  ON email_allowlist (owner_id, kind, value);

-- ── email_refusal: metadata-only log of refused mail (decision 0028 ruling 7) ──
-- No body is ever retained for refused mail — sender, time, reason only. Powers
-- the "recent refusals → allowlist in one click" affordance in Settings.
CREATE TABLE email_refusal (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    text,
  from_addr   text,
  to_addr     text,
  reason      text NOT NULL,
  refused_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_refusal_refused_idx ON email_refusal (refused_at DESC);
