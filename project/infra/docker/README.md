# infra/docker: compose stack

The per-tenant stack is **seven containers plus one-shot init jobs plus an optional
redaction profile**: **caddy** (TLS, SPA static files,
reverse proxy), **app**, **worker**, **PostgreSQL** (source of truth), **Qdrant**
(rebuildable index, spec §4.2), **MinIO** (encrypted file bytes, SSE),
**Zitadel** (identity).

Contains: the multi-stage `Dockerfile` (app/worker runtime + caddy stage), the
Caddyfile, Zitadel provisioning/bootstrap init, the MinIO bucket-init job, and the
one-shot migration init container. The `docker-compose.yml` itself lives at the
**repo root** ( ruling, `docker compose up` on a fresh clone is the contract,
) and references the files here. Profiles: `demo` (Ana sandbox) and
`redaction` (spec §12.2) are declared as documented placeholders until those features ship.
