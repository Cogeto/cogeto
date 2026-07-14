# infra — packaging & provisioning

Everything that turns the codebase into a running per-tenant instance.
Governed by Addendum §A.2: **`docker compose up` is the contract** — one command on
a fresh clone must reach a usable login, or the build is broken.

- `docker/` — Dockerfile, Caddyfile, init-container scripts. The
  `docker-compose.yml` itself lives at the **repo root** so `docker compose up`
  works on a fresh clone with zero steps (S1-A; see `docker/README.md`).
- `deploy/` — the **pull-only customer-instance stack** (decision 0030): the
  compose file + production Caddyfile the operator script
  (`scripts/operator/cogeto`) installs on a fresh OVHcloud instance. No
  `build:` keys — customer instances pull the cosign-signed release images
  (`cogeto/cogeto`, `cogeto/cogeto-edge`, `cogeto/cogeto-mail`) and never
  build. Mirror root-compose changes here (the operator spec enforces it).

Requirements (§A.2): healthchecks + `service_healthy` ordering; migrations as a
one-shot init container (never on app boot); Zitadel bootstrapped by provisioning
config (first org, admin, OIDC app — zero clicks); MinIO bucket init job;
`--profile demo` seeds the Ana sandbox persona (§B.9).

Depends on: the app/worker images built from `project/src/`. No source code here.
