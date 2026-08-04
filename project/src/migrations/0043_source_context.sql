-- 0043: the source context (V2.1 item 4.2, spec 1.5): anchoring.
--
-- Before chunking, one cheap model call over the document's opening and its
-- filename produces a SOURCE CONTEXT: the subject entities the document is
-- about (product models, project names, parties), its document class
-- (datasheet, specification, manual, contract), and its revision, each marked
-- confident or uncertain. The context is stored here and injected into every
-- chunk's extraction call, so a chunk saying only "Device has one antenna"
-- extracts as a fact about model AAA rather than about "device".
--
-- Owned by ingestion: the anchor call is a pipeline stage and the extract
-- stage is the consumer, the extraction-gate precedent. Deliberately NOT a
-- column on file_metadata (memory's), for the reason file_read_report was not:
-- a discard-mode upload has no metadata row at all, and it still has extracted
-- facts that need an anchor. Keyed by (source_type, source_id) so the sources
-- that follow (web, connectors) need a row, not a migration.
--
-- Content-bearing: subjects and revision are the document's own words, so the
-- row joins the deletion cascade (ingestion registers a DerivedCascade; the
-- saga erases it with its source and counts it in the receipt).
--
-- `edited_by_user` marks a hand-corrected context: the anchor call never
-- overwrites it, and correcting it re-anchors the source's facts as
-- supersessions through the reprocess path (spec 1.5.3). `prompt_version` is
-- the anchoring prompt that produced a machine context; NULL once a user has
-- edited, because the row then records their words, not a model's.

CREATE TABLE source_context (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  -- [{"name": "...", "confident": true|false}, ...] in document order.
  subjects jsonb NOT NULL DEFAULT '[]'::jsonb,
  document_class text,
  document_class_confident boolean NOT NULL DEFAULT false,
  revision text,
  revision_confident boolean NOT NULL DEFAULT false,
  edited_by_user boolean NOT NULL DEFAULT false,
  prompt_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX source_context_source_idx
  ON source_context (source_type, source_id);
CREATE INDEX source_context_owner_idx
  ON source_context (owner_id);
