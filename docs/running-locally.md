# Running Cogeto locally

The standing contract (Addendum §A.2): **`docker compose up` on a fresh clone
reaches a usable login** — zero configuration. Everything below is detail
around that one command.

## Prerequisites

- **Docker Engine + the compose plugin** (Docker Desktop is fine). The stack
  builds locally on first run; any recent machine with ~8 GB free RAM is
  comfortable.
- **Node 22 + npm** only if you develop (tests, lint, builds) — not needed to
  just run the stack.
- Optional: a **Mistral API key** ([console.mistral.ai](https://console.mistral.ai))
  for model features. Without it the stack runs — login, capture, dashboard,
  queue — and model calls fail with a typed error instead of pretending.

## Up

```sh
git clone https://github.com/Cogeto/cogeto.git
cd cogeto
docker compose up
```

First run builds the images and initializes Zitadel (a minute or two). When
the stack is healthy, open **https://localhost** — the dev edge serves a
self-signed certificate (Caddy's internal CA), so accept the browser warning —
and sign in as the dev bootstrap admin:

> **admin@cogeto.localhost** / **DevPassword1!**

To set the model key (or override any default), copy
[`.env.example`](../.env.example) to `.env`, edit, and `docker compose up -d`
again. The dev defaults are safe for localhost only; a preflight container
refuses known dev secrets on any non-localhost domain.

## Where things are

| Thing | Where |
| --- | --- |
| The app (SPA + API + login) | `https://localhost` (Caddy → app + Zitadel on one origin) |
| Aggregate health | `https://localhost/api/health` (public by design) |
| Zitadel console (manage users) | `https://localhost/ui/console` — same admin login |
| Infra consoles (MinIO, Qdrant) + the S3 presign origin | dev-only profile: `docker compose --profile consoles up -d`, then `https://minio.localhost:8443`, `https://qdrant.localhost:8443`, `https://s3.localhost:8443` — after adding the `*.localhost` hosts entries (decision 0017) |
| Inbound test email (no real DNS) | `node scripts/dev/send-test-email.mjs` — see [`notes/email-inbound.md`](notes/email-inbound.md) |
| The Ana demo sandbox | `COGETO_DEMO_MODE=1 docker compose --profile demo up --build`; password printed by `docker compose logs demo-seed` |
| Redaction tier (local NER before any model call) | `REDACTION_ENABLED=1 docker compose --profile redaction up --build` |
| Logs | `docker compose logs -f app` (or `worker`, `mail`, `caddy`, `zitadel`) |

## Developing

```sh
npm ci
npm run lint          # ESLint + Prettier
npm run boundaries    # module-map check (dependency-cruiser)
npm run build         # shared → server → web
npm run test          # Vitest; integration suites start real containers (needs Docker)
```

Run Vitest from `project/src` (or via `npm run test` at the root) — not with a
bare `vitest` from the repo root, which breaks the prompt-artifact paths. The
eval harness needs a model key: `MISTRAL_API_KEY=... npm run eval`.

## Common issues

- **Port 80/443 already taken** — another web server is running; stop it, or
  change the published ports in a compose override. Port **25** (inbound mail)
  is often taken or blocked locally: set `COGETO_MAIL_HOST_PORT=2525` and pass
  `--port 2525` to the test-send script.
- **File downloads don't resolve** — presigned URLs use the
  `https://s3.localhost:8443` origin, which needs the `consoles` profile up
  and the `*.localhost` hosts entries (decision 0017).
- **Chat/extraction returns a model-gateway error** — no `COGETO_MISTRAL_API_KEY`
  set. That's the designed behavior, not a crash.
- **A one-shot init container "exited (0)"** — normal: `preflight`, `migrate`,
  `minio-init`, `zitadel-init`, and the volume-permission jobs run once per
  `up` and exit.
- **Wiping and starting over** — `docker compose down -v` deletes all data
  (including the instance signing key and receipts). On a dev box that's fine;
  it is never the answer on a real instance.
- **System panel shows red integrity/queue findings after experiments** — the
  sweep and dead-letter surfaces are honest by design; see the System page
  detail before assuming breakage.

## What runs (nine long-lived containers)

`caddy` (edge/TLS) · `app` (API + SPA, fast path) · `worker` (all slow jobs) ·
`mail` (receive-only inbound SMTP) · `postgres` (source of truth) · `qdrant`
(rebuildable vector index) · `minio` (encrypted originals) · `zitadel`
(identity) — plus one-shot init jobs. Architecture rationale:
[`Cogeto-Technical-Architecture.md`](Cogeto-Technical-Architecture.md).
