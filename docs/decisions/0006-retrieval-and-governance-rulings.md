# 0006 — Retrieval and governance rulings (Session 3)

**Date:** 2026-07-03 · **Status:** accepted · **Governs:** the FTS configuration,
entity storage, memory editing, and review-rejection semantics. **Driven by:** the
S3-A owner prompt (which numbered these rulings "0004"; records 0004 and 0005 were
taken by the S2 sessions, so this file is 0006 — content unchanged).

## Ruling 1 — Postgres FTS uses `simple` + `unaccent`

Full-text search runs on the `simple` configuration over unaccented text, not a
per-language dictionary.

*Rationale:* Croatian has no built-in Postgres dictionary; `simple` + `unaccent` is
predictable across languages; revisit per-language configs when eval data justifies it.

## Ruling 2 — Entities live on the memory row as `text[]` + GIN trigram index

Extracted entities are stored on the `memory` row as an `entities text[]` column
with a GIN trigram index (`pg_trgm`); a normalized entity table is deferred until a
feature needs it.

*Rationale:* retrieval-time entity match is a lookup, not a join — the array plus
trigram index serves §A.5 without inventing a table no feature reads yet.

## Ruling 3 — Editing a memory's content is supersession, never mutation

An edit creates a **new** memory (status `user_approved`, provenance pointing at the
same source plus an edit audit entry) and marks the old one `replaced` with
`superseded_by` set. History is never destroyed.

*Rationale:* §B.2's "supersession closes intervals, never destroys history" applies
to user edits exactly as it does to reconciliation — one rule, no second write path.

## Ruling 4 — Rejecting an uncertain memory in review is a memory-level deletion

Rejection performs an audited, idempotent removal of the memory row and its Qdrant
point through a guarded path on the Memory aggregate. Deletion receipts remain
reserved for source-level deletions (Addendum §B.1); this ruling narrowly extends
the "only the saga hard-deletes" rule (§A.1 rule 4) to cover single-memory review
rejection, with `audit_log` as the record.

*Rationale:* a rejected extraction is pipeline noise, not user data with a source to
forget — receipts would attest to the wrong thing, while the audit row keeps the
removal accountable.
