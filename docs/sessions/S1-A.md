# Session S1-A — rulings, scaffold, Docker, working login

**Date:** 2026-07-02 · **Scope:** Session 1 Part A (per the owner's prompt).
S1-B (migration 0001, outbox/queue, seams' real implementations) has **not** been started.

## What was built

### Rulings & docs

- `docs/decisions/0003-pre-code-rulings.md` — five binding rulings: migration 0001
  contents; memory module owns all storage access (Principal-gated search primitives);
  `sensitive` as an orthogonal boolean + six-value status enum (Option A); connector
  placement (callbacks in app, sync in worker, tokens encrypted at callback); the
  "seven containers + init jobs + optional redaction profile" terminology.
- Targeted edits for ruling 3: `docs/glossary.md` (Status entry rewritten, new
  **Sensitive** entry), `AGENTS.md` (data-model and hard-gates bullets).
- `project/infra/README.md` + `project/infra/docker/README.md` — compose location
  and container-count wording aligned with ruling 5.
- `.gitignore` — `!.env.example` exception (the `.env.*` pattern would have ignored it).

### Monorepo (npm workspaces, TypeScript strict, Node 22)

- Root: `package.json` (scripts: `lint`, `boundaries`, `build`, `test`),
  `tsconfig.base.json`, ESLint 9 flat config + Prettier, `.dependency-cruiser.cjs`,
  `.github/workflows/ci.yml` (lint → boundaries → build → test on push/PR).
- `project/shared` (`@cogeto/shared`) — cross-tier DTOs: `Principal`, `HealthReport`,
  `WebConfig`, and the memory enums per ruling 3 (`MEMORY_STATUSES` ×6,
  `STATUS_MULTIPLIERS` per §A.5).
- `project/src` (`@cogeto/server`) — NestJS 11; one directory per bounded context
  (`memory`, `ingestion`, `retrieval`, `agents`, `connectors`, `tasks`, `identity`,
  `model-gateway`), each a Nest module with exactly one `index.ts` barrel.
  `memory`'s placeholder `MemoryStore` already encodes ruling 2 (every search
  primitive requires a `Principal`). The `identity` seam is real: Bearer guard +
  `GET /api/me`, resolving the Principal via Zitadel's userinfo endpoint (node:http
  with Host override; JWKS validation can replace it inside the seam later).
  `model-gateway` is a provider-neutral placeholder (complete/embed/rerank).
- `project/src/entrypoints` — composition roots: `app.ts` (HTTP, global prefix
  `/api`), `worker.ts` (application context, no HTTP, heartbeat file for its
  healthcheck), `migrate.ts` (one-shot ledger baseline), Zod-validated `COGETO_*`
  config (fail-fast boot; 3 unit tests), pino logger with token/content redaction.
- `project/web` (`@cogeto/web`) — Vite 7 + React 19 + Tailwind 4 + TanStack Query.
  Hand-rolled OIDC authorization-code + PKCE (S256) — no router or OIDC client
  dependency for two pages. Dashboard shell: user name + organization from
  `/api/me`, system status panel polling `/api/health`, disabled left-nav stubs
  (Memories, Chat, Review, Forgotten, Settings), brand assets copied unmodified
  from `assets/brand` into `project/web/public/brand/`.

### Backend endpoints (app process)

- `GET /api/health` — aggregate Postgres/Qdrant/MinIO reachability (+ `/api/health/live`).
- `GET /api/me` — the Principal (guarded).
- `GET /api/config` — issuer + clientId written by the zitadel-init job.

### Docker & compose

- `project/infra/docker/Dockerfile` — one multi-stage build: deps → build
  (tsc + Vite) → `runtime` target (slim, prod deps of `@cogeto/server` only,
  non-root, app/worker/migrate share it) and `caddy` target (Caddyfile + SPA
  static build baked in).
- `docker-compose.yml` (repo root) — caddy, app, worker, postgres:17, qdrant,
  minio, zitadel; one-shot init jobs: `migrate`, `minio-init`, `machinekey-init`
  (volume ownership for Zitadel's PAT), `zitadel-init` (creates the `cogeto`
  project + `cogeto-web` OIDC SPA app via the FirstInstance machine-user PAT,
  writes `/web-config/config.json`); healthchecks on every long-running service;
  `service_healthy` / `service_completed_successfully` ordering; named volumes;
  `demo` and `redaction` profiles as documented placeholders. Works with zero
  configuration; `.env.example` documents every variable with safe dev defaults.
- Caddy: `local_certs` (internal CA) on `https://localhost`, serves the SPA,
  proxies `/api/*` to app and the Zitadel path set to zitadel:8080.

## Deviations & interpretations (owner attention)

1. **Entrypoints path** — the prompt said `project/entrypoints/`; decision 0001 and
   `project/src/README.md` fix entrypoints at `project/src/entrypoints/`. I followed
   decision 0001 (binding record; entrypoints must live inside the compiled package
   anyway). Say the word and I'll move them + record a decision.
2. **Image pins** — `minio/minio:latest` + `minio/mc:latest` (MinIO uses date-stamp
   tags; pin at provisioning time), `qdrant/qdrant:v1.14.0`,
   `ghcr.io/zitadel/zitadel:v2.65.1`, `postgres:17-alpine`, `caddy:2-alpine`,
   `node:22-alpine`, `busybox:stable`.
3. **Token validation** — /api/me validates tokens via Zitadel's **userinfo**
   endpoint (no new dependency) instead of local JWKS verification. Correct OIDC
   resource-server practice either way; swapping to `openid-client`/JWKS later is
   contained inside the identity seam.
4. **MinIO SSE** — server-side encryption needs a KMS (KES) and is a managed-
   instance provisioning concern; not configured in the dev compose (§A.9 posture
   unchanged).
5. **New dev-dependencies within committed families** — `@eslint/js`,
   `typescript-eslint` (ESLint 9 flat-config companions), `@tailwindcss/vite`,
   `@vitejs/plugin-react`, `@types/*` — all standard companions of stack items
   committed in decision 0002; no new runtime frameworks.

## Verification performed (all green)

- `npm run lint` · `npm run boundaries` · `npm run build` · `npm test` (3 unit tests).
- dependency-cruiser intentional-violation check: a cross-module internal import
  and a seam→domain import were both flagged as errors, then removed; clean run after.
- Fresh-volume `docker compose down -v && docker compose up -d --wait` converges:
  **7/7 containers healthy, 4/4 init jobs exit 0** (~35 s after images exist).
- Through Caddy (`https://localhost`, internal CA — browser will warn once):
  `/api/config` returns the bootstrap client id; `/api/health` all-ok;
  `/.well-known/openid-configuration` has issuer `https://localhost`;
  `/oauth/v2/authorize` (real client id + PKCE params) 302s into the login UI,
  which renders (200); `/api/me` → 401 without/with a bad token — the 401 (not
  a 500) proves the app→Zitadel userinfo path works end to end.

## Errata (post-session fixes)

- The Caddy Zitadel matcher originally proxied `/assets/*`, which collided with
  Vite's `/assets/` bundle path and blanked the SPA (404 on CSS/JS). Narrowed to
  Zitadel's real asset API path `/assets/v1/*`; SPA assets and login UI verified 200.

## Owner verification checklist

1. `docker compose up -d --wait` on a clean checkout (or after `docker compose down -v`).
2. Open **https://localhost** — accept the local-CA warning once.
3. Click **Sign in** → Zitadel login → user `admin@cogeto.localhost`,
   password `DevPassword1!` (dev defaults; override via `.env`).
4. Expect the dashboard shell: your name + organization "Cogeto", system status
   panel with PostgreSQL / Qdrant / MinIO all **up**, disabled future nav sections.
5. Sign out; confirm you land back on the sign-in card.
6. `npm ci && npm run lint && npm run boundaries && npm run build && npm test`.

## Not done (S1-B and later, by design)

Migration 0001 (contractual core per ruling 1), outbox + Graphile Worker, real
seam implementations (Mistral, Drizzle, Qdrant, S3), Playwright e2e, Testcontainers
integration tests, demo/redaction profile contents.
