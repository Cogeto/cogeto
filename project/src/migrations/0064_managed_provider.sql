-- 0064: the managed provider row (hosted provisioning, task A).
--
-- A hosting platform provisions Cogeto instances unattended, so exactly ONE
-- provider row per instance may be MANAGED: reconciled at boot from a
-- platform-rendered configuration file plus a bootstrap key in the
-- environment. Everything about the row stays ordinary provider data; the two
-- columns below are the whole schema cost of the feature.
--
--   managed        marks the single reconciled row. The interface refuses to
--                  edit, key or delete it; the boot reconciler is its only
--                  writer. The partial unique index makes "exactly one" a
--                  database fact rather than a convention, and doubles as the
--                  race arbiter when both composition roots reconcile at once.
--
--   model_aliases  a served-name to upstream-identifier map. When present,
--                  the served names are the ONLY models the provider offers:
--                  discovery lists exactly the map's keys, manual entry
--                  accepts only served names, and the translation to the
--                  upstream identifier happens at one seam in the
--                  OpenAI-compatible adapter, where the outgoing request's
--                  model field is written. Nothing outside that seam ever
--                  needs an upstream identifier, which is why nothing else
--                  stores one.
--
-- Content: none. Model names and an endpoint, never anyone's memories.
-- Hand-configured providers keep both columns at their defaults and are
-- byte-identical to what they were before this migration.

ALTER TABLE model_provider ADD COLUMN managed boolean NOT NULL DEFAULT false;
ALTER TABLE model_provider ADD COLUMN model_aliases jsonb;

CREATE UNIQUE INDEX model_provider_one_managed_key
  ON model_provider (managed)
  WHERE managed;
