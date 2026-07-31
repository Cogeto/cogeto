# Instance and supply-chain hardening

This document covers the operational security surface: proving a pulled image is
genuine, how per-instance secrets are generated and guarded, what is encrypted,
and the logging discipline that keeps personal data out of logs.

## Supply chain: signed images and an SBOM

A customer instance is **pull-only**: it pulls prebuilt release images and never
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
update, and GitHub Actions workflows pin their actions by commit SHA.

### The verifier itself, and the files that define the stack

A signature chain is only as good as the thing that checks it. The installer
used to download `cosign` as root and make it executable with no verification at
all, which meant the entire image-provenance chain terminated in an unverified
binary: substituting it (a compromised release asset, a CDN compromise,
corporate TLS interception) would have yielded root code execution **and**
silently green signature verification afterwards.

Two things close that (security audit 2.0, SEC-13):

- **cosign is verified before it is trusted.** Its sha256 is pinned in the
 operator script itself, and the download is compared against that pin *before*
 it is made executable or moved onto `PATH`. A mismatch aborts the install
 loudly and deletes the download. The checksum is pinned in the script rather
 than fetched from the release, because a checksum file fetched from the same
 place at the same moment proves nothing: whoever could swap the binary could
 swap the file beside it. Bumping cosign is a reviewed change to two adjacent
 lines.
- **Deployment files are pinned by commit, not by tag.** The compose file, the
 production Caddyfile, the Zitadel bootstrap script, the Postgres role
 provisioning and the SearXNG settings are fetched from the repository. Git tags
 are mutable unless protected, so "at v1.2.3" was not a fixed set of bytes. The
 installer now resolves the tag to the immutable **commit SHA** it points at,
 prints it, and fetches everything at that commit, together with a checksum
 manifest (`project/infra/deploy/deploy-assets.sha256`) fetched at the same
 commit, against which every file is verified before it is moved into place. A
 missing manifest, a missing entry, or a mismatch each abort the install. The
 manifest is generated from the working tree
 (`node scripts/ci/deploy-assets-manifest.mjs --write`) and a test fails the
 build if it drifts from the files it covers.

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

## Abuse limits survive a restart

The per-user daily model budget and the ingest, research and request-rate limits
are the only thing standing between an abusive or runaway account and the
operator's model spend. They used to live in per-process maps, so a restart
cleared them, which meant an app crash-looping under attack *removed* the cap,
and the app and worker each enforced their own half of the truth.

They are now Postgres rows (`usage_counter`, `rate_limit_window`, migration
0038): durable across a restart, shared between the app and the worker, and
evicted rather than growing without bound. The enforcement logic is unchanged,
and a parity test runs the same script of requests through the in-process and
durable stores and asserts the same allow/deny sequence.

The worker used to be exempt entirely: it registered the model gateway without
the budget decorator, so extraction, verification, embedding, dreaming, skill
advance and research conclusion ran with no daily ceiling at all. The enqueuing
principal now travels in the job payload and the worker's task wrapper opens a
usage scope from it, so that work is charged to the user who caused it. Recurring
instance-wide jobs have no causing user and stay unattributed, except the
dreaming cycle, which opens a scope per owner as it reconciles that owner's
batch. The default caps were raised in the same change to match what the budget
now counts, sized off the ingest quota so a legitimate day never reaches them.

Details: [`docs/security/README.md`](README.md) and
`project/src/infrastructure/durable-limits.integration.spec.ts`.

## Logging discipline

Logs never contain memory content or tokens. The logger applies a redaction path
list that strips sensitive fields, memory and note content, bearer tokens, and
email fields (subject and bodies), before anything is written. This is enforced
in code, not left to reviewer discipline, so a stray log line cannot exfiltrate
personal data.

## Where this lives in the code

- Release signing + SBOM: `.github/workflows/release.yml`
- Operator secret generation + preflight: `scripts/operator/cogeto`,
 `project/src/entrypoints/secret-preflight.ts`
- Deployment hardening checks: `project/src/entrypoints/deployment-hardening.spec.ts`
- Installer trust chain: `scripts/operator/cogeto` (`install_cosign`,
 `fetch_deploy_assets`), `scripts/ci/deploy-assets-manifest.mjs`
- Durable abuse limits: `project/src/infrastructure/{daily-counters,rate-limit-store}.ts`,
 `project/src/migrations/0038_durable_abuse_limits.sql`
- Container resource ceilings: both compose files (`mem_limit` / `cpus` / `pids_limit`)
- Logging redaction: `project/src/entrypoints/logger.ts`
- Edge config: `project/infra/deploy/Caddyfile`
