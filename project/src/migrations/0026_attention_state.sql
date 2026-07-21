-- 0026: attention read-state (Post-v1 Priority 2 — decision 0039).
--
-- The "what needs my attention" feed and the dashboard statistics are COMPUTED
-- per Principal over signals the instance already produces (tasks, review
-- queues, approvals, the dreaming digest). Nothing about the items themselves
-- is materialized. The ONLY durable state is this pair of tiny, content-free
-- per-user tables that make the unread indicator honest:
--
--   attention_state      — when the user last viewed the attention surface;
--                          "new" means an item newer than this mark.
--   attention_dismissal  — per-item dismissal for digest lines (a live count
--                          like "3 items in review" is never dismissible).
--
-- Both are keyed by the Zitadel user id (owner_id), like every other per-user
-- row. Dismissal keys are content-free by construction (run ids + indices),
-- so this table never stores memory text. Co-located with audit_log/outbox in
-- infrastructure because the surface spans every module and no single bounded
-- context owns it (§A.1 rule 2).

CREATE TABLE attention_state (
  owner_id     text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attention_dismissal (
  owner_id     text NOT NULL,
  item_key     text NOT NULL,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, item_key)
);
