# connectors — bounded context

Source integrations — **two in v1** (per [`docs/Cogeto-v1-Roadmap-Revision.md`](../../../docs/Cogeto-v1-Roadmap-Revision.md), BINDING): **notes** (manual/quick capture)
and **email** — built in that order. Email arrives by forwarding into a per-tenant,
receive-only **Haraka** SMTP container (no OAuth, no CASA, no sending). Calendar is
dropped from v1 (reconsidered only post-2.0). Notes first for zero OAuth friction.

Responsibilities: sync with external sources, normalize items, and emit ingestion
events **transactionally via the outbox** (§A.3) — an item can never be ingested
and silently unprocessed. Keeps sync state (delta/history tokens) per source.

Owns: the `note` table (S2-A), the email tables (O4), the `web_page` table
(Post-v1 Priority 5 Part A — web research, decisions 0042/0043), and later
connector sync-state and token tables (tokens encrypted).

May depend on: `identity` (per-user auth context), the outbox, and `ingestion`'s
public interface (the job-type constant and the `SourceReader` port it implements —
dependency points connectors → ingestion, never the reverse). Never touches
memory tables — extraction belongs to `ingestion`.

S2-A surface: `POST /api/notes` (capture + transactional pipeline enqueue),
`GET /api/notes/:id` (source drawer), `GET /api/notes/:id/status` (pipeline poll),
and `NotesSourceReader` for the pipeline's ingest stage.

Post-v1 web research (Priority 5 Part A): `POST /api/research/search`
(SearXNG discovery, budget-gated), `POST /api/research/capture` (the narrow
hardened fetcher → `web_page` sources + transactional pipeline enqueue),
`GET /api/research/:id/source` (source drawer), and `WebSourceReader` /
`WebSourceDeletion` for the pipeline and the deletion saga.
