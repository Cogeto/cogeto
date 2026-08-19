# Running Cogeto locally

The standing contract (the specification): **`docker compose up` on a fresh clone
reaches a usable login**: zero configuration. Everything below is detail
around that one command.

> **This stack is for your own machine.** Zero configuration is bought with
> committed development secrets, including the `admin@cogeto.localhost /
> DevPassword1!` bootstrap login, which is identical on every clone. Running
> it anywhere reachable from the internet publishes an instance with public
> credentials. To run a real instance, use the operator script:
> [deployment](deployment.md) and the [operator runbook](operator-runbook.md).

## Prerequisites

- **Docker Engine + the compose plugin** (Docker Desktop is fine). The stack
 builds locally on first run; any recent machine with ~8 GB free RAM is
 comfortable.
- **Node 24 + npm** only if you develop (tests, lint, builds): not needed to
 just run the stack.
- Optional, for model features: an API key from a supported provider (e.g.
 Mistral, [console.mistral.ai](https://console.mistral.ai)), added **in the
 interface** after login (Providers in the left rail). Without one the stack
 runs, login, capture, dashboard, queue, and model calls fail with a typed
 error instead of pretending.

## Up

```sh
git clone https://github.com/Cogeto/cogeto.git
cd cogeto
docker compose up
```

First run builds the images and initializes Zitadel (a minute or two). When
the stack is healthy, open **https://localhost**: the dev edge serves a
self-signed certificate (Caddy's internal CA), so accept the browser warning:
and sign in as the dev bootstrap admin:

> **admin@cogeto.localhost** / **DevPassword1!**

Model providers are not configured in `.env`: after login, add one in the
interface (**Providers** in the left rail, then assign the tiers under
**Models**; keys are stored encrypted in the instance database). To override
any other default, copy [`.env.example`](../.env.example) to `.env`, edit, and
`docker compose up -d` again. The dev defaults are safe for localhost only; a
preflight container refuses known dev secrets on any non-localhost domain.

## Where things are

| Thing | Where |
| --- | --- |
| The app (SPA + API + login) | `https://localhost` (Caddy → app + Zitadel on one origin) |
| Aggregate health | `https://localhost/api/health` (needs a signed-in session; the operator role additionally sees each check's detail and error) |
| Zitadel console (manage users) | `https://localhost/ui/console`: same admin login |
| Infra consoles (MinIO, Qdrant) + the S3 presign origin | dev-only profile: `docker compose --profile consoles up -d`, then `https://minio.localhost:8443`, `https://qdrant.localhost:8443`, `https://s3.localhost:8443`: after adding the `*.localhost` hosts entries |
| Inbound test email (no real DNS) | `node scripts/dev/send-test-email.mjs`. See [`operations/email-inbound.md`](operations/email-inbound.md) |
| The Ana demo sandbox | `COGETO_DEMO_MODE=1 docker compose --profile demo up --build`; password printed by `docker compose logs demo-seed` |
| Redaction tier (local NER before any model call) | `REDACTION_ENABLED=1 docker compose --profile redaction up --build` |
| Logs | `docker compose logs -f app` (or `worker`, `mail`, `caddy`, `zitadel`) |
| Capability states | System → Capabilities, `/api/health`, and the app boot log's `Capabilities: ...` banner. Note: CLI `--profile` flags are invisible to the containers: for the registry to show a profile-run capability as enabled, put it in `COMPOSE_PROFILES` in `.env` (then plain `docker compose up` activates it) or set the explicit flag (`COGETO_RESEARCH_ENABLED=1` / `COGETO_CONSOLES_ENABLED=1`; redaction and demo already have `REDACTION_ENABLED` / `COGETO_DEMO_MODE`). See [`features/capabilities.md`](features/capabilities.md). |

## Developing

Prereqs for development: **Node 24 + npm** (the [`.nvmrc`](../.nvmrc) at the
repo root pins the major) and **Docker** for the integration suites and the
dev stack.

```sh
npm ci
npm run lint # ESLint + Prettier
npm run boundaries # module-map check (dependency-cruiser)
npm run build # shared → server → web
npm run test # Vitest; integration suites start real containers (needs Docker)
```

Run Vitest from `project/src` (or via `npm run test` at the root), not with a
bare `vitest` from the repo root, which breaks the prompt-artifact paths. The
eval harness needs a model key: `COGETO_MISTRAL_API_KEY=... npm run eval`
(harness-only: it runs against no instance database).

### Running one spec file

`npm run test` fans out over three workspaces and runs the backend suites
serially (`fileParallelism: false` in `project/src/vitest.config.ts`), so the
loop for a single change is to run one file from the workspace that owns it:

```sh
cd project/src
npx vitest run infrastructure/api-error.spec.ts

cd project/web
npx vitest run src/components/nav.spec.tsx
```

Two things to know:

- **Which suites need Docker:** the `*.integration.spec.ts` files start real
  Postgres / Qdrant / MinIO containers via Testcontainers; plain `*.spec.ts`
  files are pure unit suites and run anywhere.
- **Frontend specs need the jsdom environment:** `project/web` has no vitest
  config, so a spec that touches the DOM must opt in per file with
  `// @vitest-environment jsdom` as its first line (see
  `project/web/src/components/nav.spec.tsx`). A component test without it
  fails with an opaque "document is not defined".

### The frontend dev server

The SPA, the API and Zitadel share one origin by design: Caddy serves all
three at `https://localhost` (see the [compose stack](../docker-compose.yml)
and `project/infra/docker/caddy/Caddyfile`). The Vite dev server gives you hot
module replacement for the SPA on top of that:

```sh
docker compose up   # the backend first
npm run dev -w @cogeto/web
```

`npm run dev -w @cogeto/web` starts Vite (`http://localhost:5173` by default).
Two things to know before relying on it:

- **It is not wired to the backend by default.** The committed
  `project/web/vite.config.ts` ships no `server.proxy`, and Caddy has no route
  to the dev server. The SPA calls the API and starts its OIDC login on its
  own origin (relative `/api` paths, and a redirect URI built from
  `window.location.origin`), so the API must be reachable on the dev origin;
  the backend lives at `https://localhost`, not on Vite's port. A local,
  uncommitted `server.proxy` override forwarding `/api` and the Zitadel paths
  to `https://localhost` is the usual wiring.
- **`@cogeto/shared` resolves from its TypeScript source**, so
  shared-workspace changes are picked up without a build step.

More in [`project/web/README.md`](../project/web/README.md).

## Common issues

- **Port 80/443 already taken**: another web server is running; stop it, or
 change the published ports in a compose override. Port **25** (inbound mail)
 is often taken or blocked locally: set `COGETO_MAIL_HOST_PORT=2525` and pass
 `--port 2525` to the test-send script.
- **File downloads don't resolve**: presigned URLs use the
 `https://s3.localhost:8443` origin, which needs the `consoles` profile up
 and the `*.localhost` hosts entries.
- **Chat/extraction returns a model-gateway error**: no model provider is
 configured yet. Add one in the interface (Providers in the left rail); that
 is the designed first-run state, not a crash.
- **A one-shot init container "exited (0)"**: normal: `preflight`, `db-init`,
 `migrate`, `minio-init`, `zitadel-init`, and the volume-permission jobs run
 once per `up` and exit.
- **Wiping and starting over**: `docker compose down -v` deletes all data
 (including the instance signing key and receipts). On a dev box that's fine;
 it is never the answer on a real instance.
- **System panel shows red integrity/queue findings after experiments**: the
 sweep and dead-letter surfaces are honest by design; see the System page
 detail before assuming breakage.

## What runs (nine long-lived containers)

`caddy` (edge/TLS) · `app` (API + SPA, fast path) · `worker` (all slow jobs) ·
`mail` (receive-only inbound SMTP) · `postgres` (source of truth) · `qdrant`
(rebuildable vector index) · `minio` (encrypted originals) · `zitadel`
(identity), plus one-shot init jobs. Architecture rationale:
[`cogeto-technical-architecture.md`](cogeto-technical-architecture.md).
