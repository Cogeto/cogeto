# 0017 — Local infrastructure domains (dev overview) + browser-reachable S3

**Date:** 2026-07-09 · **Status:** accepted · **Governs:** how the
infrastructure consoles (MinIO, Qdrant) are reached in local dev, and the
browser-reachable S3 endpoint that makes O1 presigned downloads work. **Driven
by:** the owner's request for a full local infrastructure overview and the O1-A
owner-checklist item (downloads need MinIO on a browser-reachable origin).
**No migration; no app code change** — Caddy + compose only.

## Decision

Keep the **single-ingress** model (only Caddy publishes host ports; every other
service stays internal). Front the infra consoles with `*.localhost` subdomains
on Caddy, using Caddy's existing internal CA. No raw host ports are opened.

| Domain | Proxies to | Purpose |
|---|---|---|
| `https://localhost` | app + Zitadel (**unchanged**) | Product, login, Zitadel console (`/ui/console`) |
| `https://s3.localhost` | `minio:9000` (S3 API) | Browser-reachable object store — **enables O1 presigned downloads** |
| `https://minio.localhost` | `minio:9001` (Console) | MinIO admin UI: buckets, objects, SSE status |
| `https://qdrant.localhost` | `qdrant:6333` | Qdrant REST + built-in dashboard (`/dashboard`) |

## Why this shape

- **The app + Zitadel stay on `localhost`.** Zitadel's `ExternalDomain`, the
  OIDC issuer, redirect URI and post-logout URI all derive from
  `COGETO_EXTERNAL_DOMAIN`. Moving the app to another host re-inits Zitadel and
  rewrites the OIDC client — not worth it. The three consoles are independent
  services, so subdomains for them are safe.
- **`s3.localhost` does double duty.** It is both the object-store overview and
  the browser-reachable origin the O1 download feature needs. Caddy v2's
  `reverse_proxy` preserves the incoming `Host` header by default, so MinIO's
  SigV4 host check on a presigned URL (signed with host `s3.localhost` via
  `COGETO_S3_PUBLIC_URL`) matches. TLS is terminated at Caddy; MinIO speaks HTTP
  internally — SigV4 does not sign the scheme, so `https→http` at the proxy is
  transparent. Internal app→MinIO calls keep using `http://minio:9000`
  (path-style, host-agnostic).
- **Do NOT set `MINIO_SERVER_URL`.** It looks tempting, but it points the
  embedded **console's** API client at `https://s3.localhost` — which is
  unresolvable from *inside* the container (that DNS is host-only) — and console
  login then fails with a 503. Presigned downloads do not need it (they rely on
  the Host header, above). `MINIO_BROWSER_REDIRECT_URL` (console origin) is safe.

## Changes

- **`docker-compose.yml`**: MinIO `--console-address ":9001"`;
  `MINIO_BROWSER_REDIRECT_URL` = `https://minio.localhost` (NOT `MINIO_SERVER_URL`
  — see above); `COGETO_S3_PUBLIC_URL` = `https://s3.localhost` in the shared
  `&cogeto-env` anchor (so app + worker agree). All overridable via env.
- **`Caddyfile`**: three `*.localhost` site blocks (plain `reverse_proxy`).
- **`.env` / `.env.example`**: documented the new optional overrides.

## Operator setup (one-time, local)

1. **DNS** — macOS does not resolve `*.localhost` by default. Add one line to
   `/etc/hosts` (sudo):
   ```
   127.0.0.1 s3.localhost minio.localhost qdrant.localhost
   ```
   (Linux with nss-myhostname resolves `*.localhost` automatically; the entry
   is still harmless.)
2. **TLS trust (optional)** — the subdomains use Caddy's internal CA, so a fresh
   browser warns until its root is trusted. Either click through for local dev,
   or export Caddy's root and trust it:
   ```
   docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
   # macOS: sudo security add-trusted-cert -d -r trustRoot \
   #   -k /Library/Keychains/System.keychain ./caddy-root.crt
   ```
3. **Apply** — `docker compose up -d --build caddy minio` (rebuild in place;
   never `down -v` — that wipes data volumes).

## Security

These consoles expose admin credentials (MinIO root, full Qdrant access). This
scheme is **local dev only** — never expose `*.localhost` (or these services) on
a reachable host. Managed instances front only `https://<domain>` (app + login);
the data stores stay private.
