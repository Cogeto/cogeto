-- 0053: the embedding index has durable state, and a rebuild is a managed
-- operation (V2.4 item 7.1, second half).
--
-- Until now the vector index was implicit: one Qdrant collection with a fixed
-- name, whose producing model was recoverable only from the per-row
-- `memory.embedding_model` stamps, and whose expected dimension came from a
-- code registry. Changing the embeddings model therefore meant editing the
-- configuration and letting the boot guard refuse to start until an operator
-- ran the reindex command by hand: a configuration change that renders the
-- instance unstartable, which is exactly the state this migration removes.
--
-- This single-row table makes the index a first-class fact: which collection
-- is ACTIVE and at what dimension, and, while a managed rebuild is running,
-- which TARGET binding is being built, into which collection, and how far it
-- has come. The rebuild job embeds the whole corpus from Postgres (the source
-- of truth, spec 4.2) into a NEW collection while the old one keeps serving,
-- and only at successful completion does the active side switch. A rebuild
-- that fails, is cancelled, or is interrupted leaves the active configuration
-- untouched; the boot guard keeps refusing genuinely alien states but now
-- recognises the rebuild states as coherent.
--
-- Content: none. Model names, collection names, counters and timestamps; the
-- one user reference is `requested_by` (who confirmed the rebuild), the same
-- posture as `model_assignment.updated_by`. Nothing here enters the deletion
-- cascade.
CREATE TABLE embedding_index_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  -- The collection searches are served from. 'memories' is every pre-0053
  -- instance's collection; the first managed switch moves off it.
  active_collection text NOT NULL DEFAULT 'memories',
  -- The active collection's vector size. NULL means "derive from the model's
  -- registry entry" (a pre-0053 instance); a managed switch records the size
  -- that was PROBED from a real embedding, so an arbitrary self-hosted model
  -- carries its true dimension instead of a registry fallback.
  active_dimensions integer,

  -- The managed rebuild, when one is live. `rebuild_status` is NULL when no
  -- rebuild exists, 'running' while the corpus is being embedded into the
  -- target collection, and 'failed' when passes stopped making progress (the
  -- error is kept so the interface can show it; resume and cancel both remain
  -- available). The switch itself is ONE transaction, so no intermediate
  -- status can ever be observed after a crash.
  rebuild_id uuid,
  rebuild_status text,
  -- The target binding: the provider RECORD id and label are opaque copies for
  -- display and re-resolution, never a foreign key (the providers module owns
  -- that table; a deleted provider fails the next pass loudly instead).
  target_provider_id text,
  target_provider_label text,
  target_model text,
  target_collection text,
  target_dimensions integer,
  -- Honest progress: embeddable facts done against the total, and the same
  -- chars/4 token estimate the budget meter charges, accumulated as spent.
  facts_total integer,
  facts_done integer,
  tokens_spent bigint,
  -- The corpus scan's keyset cursor, and how many missing facts the current
  -- sweep has found so far. A sweep that reaches the end having found ZERO
  -- missing facts is what proves the target collection complete; rows
  -- ingested mid-rebuild are caught because the next sweep starts over.
  rebuild_cursor text,
  sweep_missing integer,
  consecutive_failures integer NOT NULL DEFAULT 0,
  rebuild_error text,
  cancel_requested boolean NOT NULL DEFAULT false,
  requested_by text,
  requested_org text,
  started_at timestamptz,
  -- A collection replaced by a completed switch, dropped on a delay so a
  -- process still holding the pre-switch configuration keeps serving a
  -- coherent old space until its poll catches up.
  retired_collection text,
  retired_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO embedding_index_state (singleton) VALUES (true);
