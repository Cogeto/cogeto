# Instance and supply-chain hardening

This document covers the operational security surface: proving a pulled image is
genuine, how per-instance secrets are generated and guarded, what is encrypted,
and the logging discipline that keeps personal data out of logs.

## Supply chain: signed images and an SBOM

A customer instance is **pull-only** — it pulls prebuilt release images and never
builds locally. Every release image (`cogeto/cogeto`, `cogeto/cogeto-edge`,
`cogeto/cogeto-mail`) is signed with **keyless cosign** (Sigstore, GitHub OIDC),
and an **SPDX SBOM** is attached to each GitHub Release and as a cosign
attestation. Verify an image before trusting it:

```sh
cosign verify cogeto/cogeto:<version> \
  --certificate-identity-regexp '^https://github.com/Cogeto/cogeto/\.github/workflows/release\.yml@refs/tags/' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
```

The signature ties the image to the exact release workflow and tag that produced
it, so a substituted or locally-built image fails verification. The same commands
are in the Docker Hub overviews ([`../dockerhub/`](../dockerhub/)) and the
[deployment guide](../deployment.md).

On the repository side, `main` is protected (no direct pushes; third-party and
bot PRs require review), release tags are protected against deletion and
update, and GitHub Actions workflows pin their actions by commit SHA. The launch
platform audit ([`../audits/launch-platform-audit.md`](../audits/launch-platform-audit.md))
records the full configuration and its verification.

## Per-instance secrets

The operator script generates every secret **locally at install** into a
`600`-permission `.env`, and secrets are never committed, transmitted, or logged
(names are logged, values never). This includes the database and object-store
credentials, the identity-provider admin credentials, the MinIO encryption master
key, and the instance signing key.

Two secrets are load-bearing for the verifiable-memory guarantees and are
generated per instance, never shipped in the repo or image:

- **The MinIO encryption master key** (`MINIO_KMS_SECRET_KEY`) enables SSE-S3
  default bucket encryption; the app re-asserts encryption is on for the
  instance's lifetime via `GET /api/health`. Losing this key makes stored objects
  unreadable by design, so it is backed up with the instance secrets.
- **The instance ed25519 signing key** is generated at first boot into a dedicated
  volume that only the migrate job writes (read-only in app and worker). It signs
  every deletion receipt; the public half is served unauthenticated at
  `GET /api/instance/public-key` so receipts verify independently. See
  [deletion-and-receipts](deletion-and-receipts.md).

A **secret preflight** refuses to start a non-localhost deployment that is still
using a known development secret value, so a stack cannot accidentally go live with
a demo password or the compose file's clearly-marked dev-only defaults.

## Encryption in transit

- **The web edge** (Caddy) obtains and renews a real Let's Encrypt certificate
  automatically once DNS points at the host, and serves the app under a strict
  Content-Security-Policy (`script-src 'self'`).
- **Inbound mail** offers opportunistic STARTTLS when a certificate is mounted in
  the mail volume; enabling it is an optional operator step covered in the
  [anti-spoofing doc](inbound-email-anti-spoofing.md) and the operator runbook.
- **The internal mail-intake endpoint** is reachable only from the mail container
  on the private Docker network and is refused at the public edge, so an internet
  caller cannot reach it.

## Logging discipline

Logs never contain memory content or tokens. The logger applies a redaction path
list that strips sensitive fields — memory and note content, bearer tokens, and
email fields (subject and bodies) — before anything is written. This is enforced
in code, not left to reviewer discipline, so a stray log line cannot exfiltrate
personal data.

## Where this lives in the code

- Release signing + SBOM: `.github/workflows/release.yml`
- Operator secret generation + preflight: `scripts/operator/cogeto`,
  `project/src/entrypoints/secret-preflight.ts`
- Deployment hardening checks: `project/src/entrypoints/deployment-hardening.spec.ts`
- Logging redaction: `project/src/entrypoints/logger.ts`
- Encryption + signing key: decision
  [0008](../decisions/0008-deletion-saga-and-encryption.md); edge config in
  `project/infra/deploy/Caddyfile`
- Platform configuration audit: [`../audits/launch-platform-audit.md`](../audits/launch-platform-audit.md)
