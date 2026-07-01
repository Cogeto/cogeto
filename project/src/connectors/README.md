# connectors — bounded context

Source integrations — exactly three in v1 (scope §4.6): **notes** (manual/quick capture),
**calendar**, **email** — built in that order (Addendum §A.11: Notes first, zero OAuth
friction; calendar next; email last, pending the Gmail/CASA decision).

Responsibilities: sync with external sources, normalize items, and emit ingestion
events **transactionally via the outbox** (§A.3) — an item can never be ingested
and silently unprocessed. Keeps sync state (delta/history tokens) per source.

Owns: connector sync-state and token tables (tokens encrypted).

May depend on: `identity` (per-user auth context), the outbox. Never touches
memory tables — extraction belongs to `ingestion`.
