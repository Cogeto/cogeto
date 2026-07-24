-- 0029: per-user instance context and language preference (P6.6 — decisions
-- 0051/0052/0053).
--
-- The model has silently lacked three things: the current date and time in the
-- right timezone, who the user is, and which language Cogeto should speak.
-- This migration adds the durable half:
--
--   user_context — one row per user: the optional profile fields that feed the
--                  prompt now-block (display name, company, role title, one
--                  line about the work), a per-user IANA timezone override
--                  (NULL = the instance timezone from QS-32 applies), and the
--                  language pair (preferred_language + strict mode). The two
--                  *_source_memory_id columns record provenance when a value
--                  was accepted from a derived suggestion (decision 0053);
--                  NULL means the user typed it themself.
--
--   context_suggestion_dismissal — a dismissed suggestion (field + exact
--                  value) is remembered and never re-proposed. Values here are
--                  short user-profile strings the user has explicitly seen and
--                  rejected, keyed by the Zitadel user id like every per-user
--                  row.
--
-- Both live in infrastructure, not a domain module: the context feeds prompts
-- in retrieval, connectors, ingestion and tasks alike, so no single bounded
-- context owns it (§A.1 rule 2) — exactly like audit_log and attention_state.

CREATE TABLE user_context (
  user_id                     text PRIMARY KEY,
  org_id                      text NOT NULL,
  display_name                text,
  company                     text,
  role_title                  text,
  about_work                  text,
  timezone                    text,
  preferred_language          text NOT NULL DEFAULT 'en',
  language_strict             boolean NOT NULL DEFAULT false,
  company_source_memory_id    uuid,
  role_title_source_memory_id uuid,
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE context_suggestion_dismissal (
  user_id      text NOT NULL,
  field        text NOT NULL,
  value        text NOT NULL,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, field, value)
);
