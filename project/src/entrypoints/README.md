# entrypoints: the two deployable processes

The app/worker split is an **entrypoint distinction, not a codebase split**
(spec §15). Both processes are built from this one source root:

- **app**: web (chat + dashboard), API, connector endpoints, approval confirm
 endpoints. Serves the fast path only: retrieval + answering, synchronous (scope §6).
- **worker**: all slow-path jobs: extraction, dedup, contradiction checks,
 consolidation/dreaming, reminders, deletion sagas, approved-action execution.
 Runs off the Postgres-backed queue (spec §15.4): transactional enqueue via the outbox,
 idempotency key `(source_type, source_id, job_type)`, retries with backoff,
 dead-letter table with dashboard visibility.

Entrypoints are composition roots: they may depend on every module in `src/`;
no module depends on an entrypoint. Nothing slow may run in the request path, ever.
