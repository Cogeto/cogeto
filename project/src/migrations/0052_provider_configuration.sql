-- 0052: model and provider configuration in the database (V2.4 item 7.1).
--
-- Until now an instance's providers, models and keys lived in `.env`, which
-- meant changing a model was an operator task with a restart in it, and a key
-- was a plaintext string in a file beside the compose stack. This moves the
-- whole configuration into six tables owned by the `providers` module, with
-- keys encrypted at rest under the instance master key, which stays in the
-- environment because a key that guards a database cannot live in it.
--
-- The environment is SEEDED into these tables once, on the first start after
-- the upgrade, and after that the database is authoritative: the model
-- variables are ignored even when they are still present. Two sources of truth
-- for one setting is a classic outage, so there is exactly one, and the seed
-- marker below is what makes "exactly once" true rather than hoped for.
--
-- Content: none of these tables holds anyone's memories, documents or
-- messages. `user_answer_model` names a user (their chosen answer model, the
-- `user_settings` shape) and is cascaded from the provider option it
-- references; nothing here enters the deletion cascade for a memory or a
-- source, for the same reason `user_settings` does not.

-- ── Provider records ────────────────────────────────────────────────────────
-- `type` is text, not an enum, for the reason source types are text since
-- migration 0040: adding a provider family is a declaration in code plus its
-- adapter, never a migration. The admin-facing set is mistral / openai /
-- anthropic / self_hosted; `ollama` exists only as a value the seed writes for
-- an instance already running the local runtime, so its configuration id and
-- its adapter behaviour are preserved exactly rather than silently reassigned.
CREATE TABLE model_provider (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The admin's own name for this endpoint. Unique because two providers of
  -- the same type are ordinary, so the LABEL is what tells them apart.
  label text NOT NULL UNIQUE,
  type text NOT NULL,
  -- Required for self_hosted and ollama; null means "the vendor's hosted API".
  base_url text,
  -- AES-256-GCM under the instance master key, versioned in the value itself.
  -- Never selected into any DTO, never logged, never returned by any endpoint.
  api_key_secret text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Tier assignments ────────────────────────────────────────────────────────
-- One row per tier, at most four rows, ever. A missing `vision` row means this
-- instance has no vision binding, which is a complete answer (V2.1 item 4.1):
-- the reading ladder stops at OCR and says so.
CREATE TABLE model_assignment (
  tier text PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES model_provider(id),
  model text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Who last changed it. An id, never a name: this is configuration history,
  -- not an audit entry, and the audit trail records the transition separately.
  updated_by text
);

-- A provider still bound to a tier cannot be deleted: the foreign key above
-- refuses it, which is the point. An instance whose pipeline tier lost its
-- endpoint would fail at the first extraction rather than at the click.

-- ── The answer models a user may choose between ─────────────────────────────
-- The admin enables the set; a user picks one. Everything else stays
-- admin-only, because pipeline and embeddings decide what gets REMEMBERED and
-- vision decides what gets read, and none of those is a personal preference.
CREATE TABLE model_answer_option (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES model_provider(id) ON DELETE CASCADE,
  model text NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, model)
);

CREATE TABLE user_answer_model (
  user_id text PRIMARY KEY,
  org_id text NOT NULL,
  -- ON DELETE CASCADE: retiring an option returns everyone who chose it to the
  -- assigned answer tier, which is exactly what the router does at call time.
  option_id uuid NOT NULL REFERENCES model_answer_option(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Configuration history ───────────────────────────────────────────────────
-- Changing any assignment produces a new configuration id, and the id is the
-- join key the published trust scores use. An admin must be able to see that
-- the instance moved off a measured configuration and when, so every change is
-- recorded here and shown in the interface.
CREATE TABLE model_configuration_change (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  configuration_id text NOT NULL,
  previous_configuration_id text,
  -- What moved: the tier, and the binding it moved to, in display form.
  tier text NOT NULL,
  provider_label text NOT NULL,
  model text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by text
);

CREATE INDEX model_configuration_change_at_idx
  ON model_configuration_change (changed_at DESC);

-- ── The single-row state marker ─────────────────────────────────────────────
-- `seeded_at` is what makes seeding happen exactly once: an instance whose
-- admin later deletes every provider must not have the environment resurrected
-- underneath them on the next restart. `version` is bumped on every change so
-- the worker, which has no request to react to, notices within one poll.
CREATE TABLE model_config_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  seeded_at timestamptz,
  -- Which environment shape produced the seed, for the upgrade record.
  seed_source text,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO model_config_state (singleton) VALUES (true);
