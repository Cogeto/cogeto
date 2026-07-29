# Architecture

Cogeto is a **modular monolith**: one codebase, DDD bounded contexts as internal
modules, exactly two deployable processes. The binding invariants are in
[`AGENTS.md`](../AGENTS.md); the authority on architecture questions is
[`Cogeto-v1-Addendum-Verifiable-Memory.md`](Cogeto-v1-Addendum-Verifiable-Memory.md)
(cited throughout as §A.x / §B.x).

## Two processes, one image

| Process | Runs |
| --- | --- |
| **app** | HTTP API + the built SPA. The fast path: retrieval and answering only. |
| **worker** | Every slow job: extraction, verification, reconciliation, the deletion saga, nightly dreaming and integrity sweeps, skill runs, passport exports. |

One Dockerfile, one artifact. Stage 1 builds the frontend (Vite) and compiles
NestJS; stage 2 is a slim runtime holding both. `app` and `worker` run the same
image with different entrypoints, and migrations run as a one-shot init container
from that same image. One thing to version, canary, and roll back across the fleet.

The two are connected by a **transactional outbox** and an idempotent job queue,
so nothing can be ingested and silently unprocessed. Enqueue happens inside the
same Postgres transaction as the write it follows.

## The stack

TypeScript / Node 22 LTS · NestJS 11 · Drizzle ORM + PostgreSQL 17 ·
Graphile Worker (Postgres job queue and outbox) · Qdrant · MinIO over the S3 API ·
Zitadel · Caddy 2 · React 19 + Vite + TanStack Query + Tailwind · Zod · pino ·
Vitest + Testcontainers + Playwright · dependency-cruiser · a Presidio-based
redaction sidecar (Python, isolated container, compose profile).

**Any substitution or addition requires owner sign-off.** Dependency cost is
multiplied by every tenant instance.

### Why a static SPA and not Next.js

Cogeto is an authenticated tool behind a login: no SEO, no crawlable pages, no
first-paint problem. Next.js would add a per-tenant Node rendering process and a
second half-backend (API routes, server components) that blurs the single-backend
boundary. Instead Vite builds React to static files at image build time; Caddy
serves them and reverse-proxies `/api/*` to NestJS and `/auth/*` to Zitadel on the
same origin, so there is no CORS. Types are shared from a common package, so an
API change that breaks the UI fails at compile time. The SPA never touches
credentials; it redirects to Zitadel for OIDC.

The public marketing site is a separate, non-tenant deployment where SSR and SEO
tooling is appropriate.

### Why Python appears only as a sidecar

Model work here is HTTPS calls plus prompt assembly plus Zod-parsing structured
output. No tensors, no GPU code, no training. That belongs in TypeScript inside
the model-gateway seam, so extraction output types are memory input types, checked
at compile time. Python appears **only** where local model execution genuinely
happens, always as an isolated container speaking HTTP behind the gateway seam,
never inside the monolith. In v1 that is the redaction service.

Accepted consequences: no Redis, no RabbitMQ, no SSR runtime, roughly a 2 GB RAM
baseline per tenant.

## Storage split

**Postgres is the source of truth. Qdrant is a rebuildable index.** Nothing exists
only in Qdrant, and `npm run reindex` (rebuild Qdrant from Postgres) must always
work. Original file bytes live in MinIO under SSE-encrypted, tenant-scoped keys
(`{orgId}/{userId}/{scope}/file-{uuid}`, org id first, never a constant).

Facts, not raw documents, are what gets stored and searched. Chunks are transient
extraction inputs and are never stored rows.

## Modules

One directory per bounded context under `project/src/`, plus `entrypoints` for the
two composition roots.

| Module | Owns |
| --- | --- |
| `memory` | The memory tables **and** the Qdrant client. Every read primitive takes a `Principal` and applies scope and sensitivity gates internally. |
| `ingestion` | The pipeline, reconciliation, dreaming, the eval harness, dormant flags. |
| `retrieval` | Fusion, ranking, the chat area and its tables. |
| `connectors` | Notes, files, email, web, the skill runtime. Source-side tables. |
| `agents` | The approval state machine and action registry. |
| `identity` | The identity seam over Zitadel. |
| `model-gateway` | The model seam. Every LLM and embedding call. |
| `infrastructure` | The queue, rate limits, audit log, user context, attention read-state. Tables no single context owns. |

Rules, enforced by dependency-cruiser in CI:

- One public interface per module; internals stay private.
- **No module reads or writes another module's tables.** Cross-module
  communication is domain events through the Postgres outbox: one mechanism, not two.
- Nothing imports `entrypoints`; seams import no domain module.
- The module graph is acyclic. Where a dependency must run the other way, it is a
  **port** defined by the owning module and implemented by the caller, bound at the
  composition root. The established family is `SourceReader`, `SourceDeletion`,
  `DerivedCascade`, `IngestionGuard`, and `ConversationAppendPort`.

Seam and infrastructure modules (`IdentityModule`, `ModelGatewayModule`,
`MemoryModule`, `ConnectorsModule`) register as global dynamic Nest modules, so the
composition root configures each once and domain modules inject without
re-registering. Visibility is still enforced by dependency-cruiser, not by Nest.

Only `entrypoints` reads the environment. Everything else takes validated options.

## The ingestion pipeline

Six stages, one job per source item, the whole run inside the job's idempotency
transaction (model calls included). Any failure rolls back everything; retries and
dead-lettering come from the queue.

1. **Ingest** through a `SourceReader` the connector implements.
2. **Chunk** (transient).
3. **Extract** structured candidate facts.
4. **Verify** each claim through an independent pass with its own prompt family.
5. **Embed and store**: batch-embed verified claims, write the memory rows and
   their `verification_result` rows in the transaction, then upsert Qdrant points
   **last**.
6. **Reconcile**: dedup, contradiction, supersession.

Persistence lives in stage 5, so a fact is embedded and persisted in one step, and
the §B.3 admission rule still decides `active` versus `uncertain` from the
verification verdict. Rows are transactional but points are not: a failed point
write rolls back the rows and retries the job, so a duplicate row is impossible.
Points written before an in-batch failure survive as unreachable orphans, because
every hit resolves through a gated Postgres read; `reindex` and the nightly sweep
clear them.

**Admission checkpoint.** Immediately before any memory row is inserted, the reader
re-verifies the durable source row still exists, taking a `FOR KEY SHARE` lock. If
a deletion saga committed first the row is gone and admission aborts as a no-op. If
the checkpoint locks first, the lock is held to commit and the saga's enumeration
waits and then erases the fresh memories under its receipt. Either interleaving
ends honestly: the receipt covers the memories, or the memories were never admitted.

A permanent extraction failure (an unparseable document) **fabricates nothing**: it
throws, the job dead-letters, and the source reads `error`. Zero memories, never a
hallucinated one.

## Seams

- **`model-gateway`.** All LLM and embedding calls. No provider SDK or endpoint
  appears anywhere else, and an architecture test keeps it that way. Callers request
  a **tier** (`pipeline`, `answer`, `embeddings`), never a model string. Decorator
  order is `budget → redaction → provider` at the single construction point, so
  there is structurally no per-provider bypass. See [`features/models.md`](features/models.md).
- **`identity`.** All identity and role lookups. No direct Zitadel calls elsewhere.
  Zitadel asserts who and which roles; memory scoping is Cogeto's own logic.

## Jobs

Slow-path work never runs in the request path. Jobs are idempotent with key
`(source_type, source_id, job_type)`, retried with backoff, and dead-lettered
visibly.

Two deliberate exceptions to the `idempotentTask` wrapper, both recurring rather
than one-shot: the nightly integrity sweep and the dreaming cycle. That key fires
once ever; a recurring pass must not. Their effects are idempotent by construction
instead (alert dedupe, watermark windows, compare-and-set transitions).

Scheduled work: the integrity sweep at 03:00, dreaming at 03:30, approval expiry
every five minutes, passport-export retention hourly. Graphile cron task names use
underscores, because the crontab parser rejects dots.

The one sanctioned enqueue on the chat fast path is the conversation auto-title job,
after a conversation's first exchange. Never ingestion work.

## Local infrastructure

Only Caddy publishes host ports; every other service stays internal. In local dev
the infrastructure consoles are fronted by `*.localhost` subdomains on Caddy's
internal CA, so no raw host ports open.

| Domain | Proxies to |
| --- | --- |
| `https://localhost` | app + Zitadel (console at `/ui/console`) |
| `https://s3.localhost` | MinIO S3 API, the browser-reachable presign origin |
| `https://minio.localhost` | MinIO console |
| `https://qdrant.localhost` | Qdrant REST + dashboard |

The app and Zitadel stay on `localhost`: Zitadel's external domain, OIDC issuer,
redirect and post-logout URIs all derive from `COGETO_EXTERNAL_DOMAIN`, and moving
the app re-inits Zitadel.

Two traps worth knowing. Caddy preserves the incoming `Host` header, which is what
makes MinIO's SigV4 host check match a URL presigned for `s3.localhost`; SigV4 does
not sign the scheme, so terminating TLS at Caddy is transparent. And do **not** set
`MINIO_SERVER_URL`: it points the embedded console's API client at a hostname that
is unresolvable from inside the container, and console login then fails with a 503.
`MINIO_BROWSER_REDIRECT_URL` is the safe one.

These consoles expose admin credentials and are **local dev only**. A customer
instance fronts only the app and login; the data stores stay private. See
[`deployment.md`](deployment.md).

## The per-tenant stack

Seven containers plus one-shot init jobs plus optional profiles: caddy, app,
worker, postgres, qdrant, minio, zitadel. Profiles add `redaction`, `research`,
`demo`, `consoles`, and `dev-seed`.

`docker compose up` on a fresh clone must reach a usable login with zero
configuration. That is a contract, not an aspiration.
