# infra — packaging & provisioning

Everything that turns the codebase into a running per-tenant instance.
Governed by Addendum §A.2: **`docker compose up` is the contract** — one command on
a fresh clone must reach a usable login, or the build is broken.

- `docker/` — compose files, Dockerfiles, healthchecks, init containers.

Requirements (§A.2): healthchecks + `service_healthy` ordering; migrations as a
one-shot init container (never on app boot); Zitadel bootstrapped by provisioning
config (first org, admin, OIDC app — zero clicks); MinIO bucket init job;
`--profile demo` seeds the Ana sandbox persona (§B.9).

Depends on: the app/worker images built from `project/src/`. No source code here.
