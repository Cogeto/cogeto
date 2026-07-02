# infra/docker — compose stack

The per-tenant stack is **seven containers plus one-shot init jobs plus an optional
redaction profile** (decision 0003, ruling 5): **caddy** (TLS, SPA static files,
reverse proxy), **app**, **worker**, **PostgreSQL** (source of truth), **Qdrant**
(rebuildable index, §A.4), **MinIO** (encrypted file bytes, SSE — §A.9),
**Zitadel** (identity).

Contains: the multi-stage `Dockerfile` (app/worker runtime + caddy stage), the
Caddyfile, Zitadel provisioning/bootstrap init, the MinIO bucket-init job, and the
one-shot migration init container. The `docker-compose.yml` itself lives at the
**repo root** (S1-A ruling — `docker compose up` on a fresh clone is the contract,
§A.2) and references the files here. Profiles: `demo` (Ana sandbox, §B.9) and
`redaction` (§B.8) are declared as documented placeholders until those features ship.
