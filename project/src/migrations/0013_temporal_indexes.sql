-- Migration 0013 — temporal retrieval indexes (Session F3-A; decision 0012;
-- research temporal-knowledge-patterns §5: "production use demands indexes on
-- both interval bounds"). Point-in-time queries filter on the shared interval
-- predicate; change queries scan audit rows by action within a window.

CREATE INDEX memory_valid_from_idx ON memory (valid_from);
CREATE INDEX memory_valid_until_idx ON memory (valid_until);
CREATE INDEX audit_log_action_time_idx ON audit_log (action, created_at);
