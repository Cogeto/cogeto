# Decision 0002 — Technology stack and application shape

**Status:** Accepted. Binding. Supersedes nothing; complements Decision 0001 (repo structure).
**Full rationale:** docs/Cogeto-Technical-Architecture.docx. This record captures the decisions and the reasons most likely to be questioned later.

## The stack

TypeScript / Node 22 LTS · NestJS 11 · Drizzle ORM + PostgreSQL 17 · Graphile Worker (Postgres job queue, outbox) · Qdrant (rebuildable index; Postgres is source of truth) · MinIO via S3 API · Zitadel · Mistral API (only model, gateway seam only) · Caddy 2 · React 19 + Vite + TanStack Query + Tailwind · Zod · pino · Vitest + Testcontainers + Playwright · dependency-cruiser (module boundaries in CI) · Presidio-based redaction service (Python, isolated container, compose profile).

Any substitution or addition requires a new decision record naming the alternative considered. Dependency cost is multiplied by every tenant instance.

## Frontend: static SPA, deliberately not Next.js

Cogeto is an authenticated tool behind a login: no SEO, no public crawlable pages, no first-paint problem. Next.js would add a per-tenant Node rendering process (fleet cost) and a second half-backend (API routes, server components) that blurs the single-backend boundary. Instead: Vite builds React + Tailwind to static files at image build time; Caddy serves them and reverse-proxies /api/* to NestJS and /auth/* to Zitadel (same origin, no CORS). TanStack Query for data; SSE for chat streaming; types shared from a common package so API changes that break the UI fail at compile time. OIDC redirect to Zitadel; the SPA never touches credentials.

Exception: the public marketing site and the Ana sandbox landing page are a separate, non-tenant deployment where SSR/SEO tooling (e.g. Next.js or a static site generator) is appropriate.

## Language boundary rule: Python where models run, TypeScript where models are called

Model work in Cogeto v1 is HTTP calls to Mistral plus prompt assembly plus Zod-parsing structured output. No tensors, no GPU code, no training. That belongs in NestJS, inside the model-gateway seam, so extraction output types are memory input types, checked at compile time.

Python appears only where local model execution genuinely happens, always as an isolated sidecar container speaking HTTP behind the gateway seam, never inside the monolith:
- v1: the redaction service (Presidio NER, CPU, ~1 GB, compose profile `redaction`).
- Later, same pattern: local embeddings/reranker, and a local utility LLM (via Ollama or similar) if volume ever justifies it.

## Docker: one multi-stage image, two entrypoints

One Dockerfile. Stage 1 builds the frontend (Vite) and compiles NestJS. Stage 2 is a slim runtime image containing both. The `app` and `worker` containers run the same image with different entrypoints. Consequences: one artifact to version, canary, and roll back across the entire fleet; migrations run as a one-shot init container from the same image; `docker compose up` on a fresh clone must reach a usable login (healthchecks + service_healthy ordering, Zitadel bootstrap, MinIO bucket init). Compose profiles: `demo` (Ana persona seed), `redaction` (NER sidecar).

## Consequences accepted

- No Redis, no RabbitMQ, no SSR runtime: smallest honest per-tenant footprint (~2 GB RAM baseline).
- Go and Python were considered for the backend and rejected for team-size and type-sharing reasons, not on merit grounds; revisit only with a decision record.
- The frontend has no server; anything that needs a server is, by definition, API work and lives in NestJS.
