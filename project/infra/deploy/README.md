# deploy — the pull-only customer-instance stack

The deployment files the operator script
([`scripts/operator/cogeto`](../../../scripts/operator/cogeto)) installs at
`/srv/cogeto` on a fresh OVHcloud Ubuntu instance (roadmap D3, decision 0030).
A customer instance **pulls the prebuilt, cosign-signed release images and
never builds** — this stack has no `build:` keys.

| File | Purpose |
| --- | --- |
| `docker-compose.deploy.yml` | The customer stack: `cogeto/cogeto`, `cogeto/cogeto-edge`, `cogeto/cogeto-mail` at `${COGETO_VERSION}`, digest-pinned infra (QS-25), secrets **required** (`${VAR:?}`), `COGETO_PRODUCTION=1`, Qdrant API-key auth always on. No demo / dev-seed / consoles / redaction profiles. |
| `Caddyfile` | Production edge: real-domain vhost + `s3.<domain>` presign origin, Let's Encrypt ACME, same routing and CSP as the dev Caddyfile. Mounted over the baked-in dev one. |

The operator script fetches these files (plus
`project/infra/docker/zitadel-init/init.mjs`) from the release tag that matches
the image version, generates `.env` with per-instance secrets, and brings the
stack up. Never `docker compose up` this file by hand without a populated
`.env` — every secret is required and missing values fail loudly by design.

Dev/local work keeps using the repo-root `docker-compose.yml` (§A.2:
`docker compose up` on a fresh clone is the contract). When you change the
root compose or the dev Caddyfile, mirror the change here — the operator spec
(`project/src/entrypoints/operator-script.spec.ts`) asserts the two stacks
stay structurally consistent.
