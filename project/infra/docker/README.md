# infra/docker — compose stack

The per-tenant stack (~5 containers, Addendum §A.1 rationale): **app**, **worker**,
**PostgreSQL** (source of truth), **Qdrant** (rebuildable index, §A.4), **MinIO**
(encrypted file bytes, SSE — §A.9), **Zitadel** (identity).

Will contain: `docker-compose.yml` (+ `--profile demo` for the Ana sandbox, §B.9),
Dockerfiles for app/worker, the one-shot migration init container, Zitadel
provisioning config, MinIO bucket-init job.

Governed by §A.2 — see `project/infra/README.md` for the contract. No compose files
yet; they are part of the first coding sessions.
