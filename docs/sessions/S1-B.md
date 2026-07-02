# Session S1-B — contractual core, aggregate, outbox/queue, seams

**Date:** 2026-07-02 · **Scope:** Session 1 Part B (per the owner's prompt).
Session 1 is now **complete**. Session 2 (Notes pipeline) starts in a fresh session.

## What was built

### Migrations (reviewable SQL, applied by the migrate init container)

- `project/src/migrations/0001_contractual_core.sql` — exactly the 0003-ruling-1 set:
  enums `scope`, `memory_status` (six lifecycle values), `source_type`,
  `receipt_status`, `approval_status`; tables `memory` (NOT NULL provenance,
  `sensitive` boolean, validity interval, `superseded_by` self-reference, the three
  prescribed indexes), `file_metadata`, `deletion_receipt`, `approval`, `audit_log`
  — with a database trigger making audit_log **append-only** (UPDATE/DELETE raise).
- `project/src/migrations/0002_infrastructure.sql` — what S1-B itself needs:
  `outbox_event`, `job_execution` (unique idempotency key), `dead_letter`,
  `prompt_registry`. Kept out of 0001 so the contractual core stays exactly §A.6.
- Shared applier `infrastructure/migrations.ts` (ledger `cogeto_migrations`, ordered
  `.sql` files, one transaction each) also installs the Graphile Worker schema; used
  by the migrate entrypoint and the test harness identically.

### Memory module (core domain)

- `domain/transition.ts` — the aggregate's single pure transition function.
  Owners: `contradicted` ← reconciliation only; `user_approved` ← user only;
  `outdated` ← consolidation or user; `uncertain` ← verification only; `active` ←
  user only; `replaced` ← **never via transition** (supersession only) and terminal.
  24 legal transitions total, unit-tested as a full 6×6×5 matrix.
- `MemoryStore` public interface: `createFromFact`, `transition`, `supersede`
  (closes `valid_until`, sets `superseded_by`, never deletes history),
  `getForPrincipal`, `listForPrincipal` — every read takes a mandatory `Principal`;
  scope and sensitive gates are built inside the private query builder, so an
  unscoped read is unrepresentable through the public interface. Sensitive rows:
  excluded by default, owner-only, explicit per-query opt-in (ruling 3). Every
  write path appends an audit row in the same transaction. User transitions on
  others' rows report NotFound (no existence leak).
- `DeletionSaga` abstract interface + stub (implementation Session 4): hard delete
  has no other path.
- Search primitives (`vectorSearch`/`fullTextSearch`/`entitySearch`) remain typed
  stubs until the Notes slice brings Qdrant/FTS/trigram.

### Infrastructure (shared, sanctioned by §A.3 and the prompt)

- Global `DatabaseModule` (one Pool + drizzle handle per process).
- `withTransactionalEnqueue(tx, event, job)` — outbox event + `graphile_worker.add_job`
  in the caller's transaction.
- `idempotentTask(db, jobType, handler)` — handler effect + `job_execution` insert
  under the `(source_type, source_id, job_type)` unique key in ONE transaction
  (at-most-once effect); throws propagate to Graphile's exponential backoff; the
  final failed attempt is parked in `dead_letter` instead of retrying forever.
- Worker entrypoint now runs the Graphile runner (concurrency 2) with the task
  registry (`entrypoints/worker-tasks.ts`); `echo` is the §A.3 round-trip demo —
  verified live in the compose stack (audit row `worker:echo / live-1`).

### Identity seam

- Request-scoped `PRINCIPAL` provider (populated by the Bearer guard); `/api/me`
  serves from the seam as before. New dependency-cruiser rule: only `identity` may
  import OIDC client libraries; (token validation stays userinfo-based per the
  S1-A record — swapping to JWKS later is contained in the seam).

### Model gateway

- Provider-neutral `ModelGateway`: `complete`, `extractStructured(schema, request)`
  (JSON mode + Zod validation + one corrective retry on schema violations), `embed`.
- `MistralModelGateway` (official client; key via `COGETO_MISTRAL_API_KEY` /
  `MISTRAL_API_KEY`) with typed `ModelGatewayError` carrying `retryable`
  (429/5xx/network → retryable; 4xx/validation → not). Without a key the process
  boots with an `UnconfiguredModelGateway` that fails on use with a typed error.
- Prompt loader over `project/prompts/` (family/vNNNN.md; `smoke/v0001` + CHANGELOG
  created) computing sha256; `recordPromptVersion` enforces immutability against
  `prompt_registry` (re-recording a changed hash fails).
- `npm run gateway:smoke` — live structured extraction when a key is set; clear
  skip message otherwise. New rule: only `model-gateway` may import `@mistralai`.

### Health & dashboard

- `GET /api/health` now includes a `migrations` check (`2 applied, latest
  0002_infrastructure.sql`); the dashboard status panel shows it as a fourth row.

## Deviations & notes (owner attention)

1. **audit_log Drizzle definition lives in `infrastructure`, not `agents`.** The
   prompt assigned audit to agents, but memory transitions must write audit rows,
   and an agents-owned table would violate §A.1 rule 2 (no cross-module table
   access) or force a module cycle. `approval` stays with agents as instructed.
   The migration SQL is unchanged either way.
2. **Two migration files, not one.** 0001 is exactly the ruling-1 contractual set;
   the queue/outbox/prompt-registry tables S1-B needs arrived as 0002 — matching
   ruling 1's "supporting tables arrive with their features".
3. **drizzle-kit not added yet.** Migrations are hand-written reviewable SQL with
   our own ledger (that was the requirement); the drizzle-kit generator can be
   adopted when schema churn justifies it (it is in the 0002 stack decision).
4. **Testing harness location:** `project/src/testing/` (Testcontainers helper),
   excluded from the production build, and a dependency-cruiser rule forbids
   production code from importing it. Application tests live under `project/`
   per repo rules.

## Verification performed (all green)

- `npm run lint` · `npm run boundaries` (91 modules) · `npm run build` ·
  `npm test` — **12/12**, including the named tests:
  - `scope_gate` — B's private memory never reaches A (direct get by id + broad list).
  - `sensitive_gate` — excluded by default; owner-only even with opt-in; shared
    scope does not override the sensitive gate.
  - `illegal_transition` — user→contradicted, verification→user_approved, and
    any→replaced-via-transition all rejected; supersession preserves the
    predecessor with a closed interval; `replaced` is terminal; audit rows written;
    audit UPDATE/DELETE rejected by the trigger.
  - `transactional_enqueue` — rollback leaves no event and no job; commit leaves
    exactly one of each.
  - `idempotent_job` — duplicate enqueue, one effect, one job_execution row.
  - `worker_retry` — crash after the effect but before commit rolls back; the
    retry succeeds with exactly one effect.
  - plus `dead_letter` (bonus) and the 180-combination transition matrix.
- `npm run gateway:smoke` without a key prints the skip message and exits 0.
- Compose stack rebuilt on the running instance: migrate applied 0001+0002,
  7/7 containers healthy, login UI and SPA intact, `/api/health` reports the
  migration status, and a live `echo` job round-tripped through the worker into
  an audit row.

## Owner verification checklist

1. `docker compose up -d --wait` → all healthy; sign in at **https://localhost**
   (`admin@cogeto.localhost` / `DevPassword1!`); the status panel now shows
   **Migrations — 2 applied, latest 0002_infrastructure.sql**.
2. `npm ci && npm run lint && npm run boundaries && npm run build && npm test`
   (Docker must be running; the integration tests start postgres:17 containers).
3. Optional live model check: `COGETO_MISTRAL_API_KEY=<key> npm run gateway:smoke`
   → prints the validated `{people, commitment}` extraction. Without the key it
   prints a skip message.
4. Optional queue check:
   `docker compose exec postgres psql -U postgres -d cogeto -c "SELECT graphile_worker.add_job('echo', '{\"source_type\":\"t\",\"source_id\":\"x\",\"message\":\"hi\"}'::json);"`
   then `SELECT * FROM audit_log WHERE entity_id='x';` — one row, and re-adding
   the same job never produces a second one.

## Not done (Session 2+, by design)

Notes pipeline (ingest → extract → verify → embed → reconcile), Qdrant adapter +
hybrid retrieval, eval harness + golden set, deletion saga implementation (S4),
approval state machine endpoints, Playwright e2e.
