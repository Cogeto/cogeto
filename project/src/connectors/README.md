# connectors — bounded context

Source integrations — exactly three in v1 (scope §4.6): **notes** (manual/quick capture),
**calendar**, **email** — built in that order (Addendum §A.11: Notes first, zero OAuth
friction; calendar next; email last, pending the Gmail/CASA decision).

Responsibilities: sync with external sources, normalize items, and emit ingestion
events **transactionally via the outbox** (§A.3) — an item can never be ingested
and silently unprocessed. Keeps sync state (delta/history tokens) per source.

Owns: the `note` table (S2-A), and later connector sync-state and token tables
(tokens encrypted).

May depend on: `identity` (per-user auth context), the outbox, and `ingestion`'s
public interface (the job-type constant and the `SourceReader` port it implements —
dependency points connectors → ingestion, never the reverse). Never touches
memory tables — extraction belongs to `ingestion`.

S2-A surface: `POST /api/notes` (capture + transactional pipeline enqueue),
`GET /api/notes/:id` (source drawer), `GET /api/notes/:id/status` (pipeline poll),
and `NotesSourceReader` for the pipeline's ingest stage.
