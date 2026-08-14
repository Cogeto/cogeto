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
- **Inbound mail** offers opportunistic STARTTLS, and obtaining the certificate
 is **automatic**: the edge orders and renews one for the mail hostname, a
 sidecar propagates it into the mail service's own volume, and the listener
 reloads it. No operator step beyond the DNS record the mail capability
 already prints. Whether it is actually advertised, and when the certificate
 expires, are reported by `cogeto status` and by the `mail` capability, so a
 cleartext posture is visible rather than silent. The mechanism, and the
 operator-supplied-certificate override, are documented once in
 [`../operations/email-inbound.md`](../operations/email-inbound.md).
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

## Container privilege

Every service in both compose files drops **all** Linux capabilities, sets
`no-new-privileges`, and gets back only what it demonstrably needs. Before this
(deployment-readiness audit F11) neither file set a single privilege restriction
on a single service: `cap_drop` 0, `security_opt` 0, `read_only` 0, `user:` 0.
The resource ceilings existed; the privilege surface did not.

The rule was applied service by service, and each grant was **verified by
running real work through the stack**, not by watching a container start. What
that caught is recorded below: Qdrant panics under a read-only root, and the
mail service needs no capability at all.

| Service | Capabilities | Read-only root | Why |
|---|---|---|---|
| `caddy`, `caddy-consoles` | `NET_BIND_SERVICE` | no | Binds 80 and 443 inside the container. It writes its certificate store, its autosave config and scratch files. |
| `app` | none | **yes**, `/tmp` tmpfs | Runs as uid 1000 and binds 3000. Uploads are held in memory and go straight to object storage; both its mounts are read-only. |
| `worker` | none | **yes**, `/tmp` tmpfs | Same image and user. `/tmp` holds the heartbeat file the healthcheck stats; `pdftoppm` and `tesseract` are driven through stdin and stdout, so a 25 MB document never lands on disk. |
| `preflight`, `migrate`, `db-init` | none | **yes** | One bounded job each. Migrate writes the instance keypair, which is a volume, and volumes stay writable under a read-only root. |
| `instance-keys-init`, `machinekey-init` | `CHOWN` | **yes** | Their whole job is `chown -R 1000:1000` on a fresh root-owned volume. |
| `minio-init` | none | **yes**, tmpfs `/tmp` + `$HOME` | `mc` needs a temp file for the policy document and a home for its alias config, so the root credential it caches never touches a disk that outlives the container. |
| `zitadel-init` | `DAC_OVERRIDE` | **yes** | Runs as root but writes into a directory owned by uid 1000, and root without `DAC_OVERRIDE` does not bypass directory permissions. Running it as 1000 instead would leave it unable to write the fresh root-owned web-config volume. |
| `postgres` | `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID` | no | The official entrypoint prepares and chowns the data directory as root and then drops to the postgres user. The server runs unprivileged after that. |
| `qdrant` | none | no | **Measured**: with a read-only root it logs `Failed to create init file indicator: .qdrant-initialized: Read-only file system` and panics at startup. Its working directory is inside the image root and cannot be moved onto a tmpfs without shadowing the config directory beside it. |
| `minio`, `zitadel` | none | **yes**, `/tmp` tmpfs | State lives in volumes and in Postgres. |
| `searxng` | `CHOWN`, `DAC_OVERRIDE`, `SETGID`, `SETUID` | no | Its entrypoint fixes ownership under `/etc/searxng` as root and drops to the searxng user, and writes a settings file beside the mounted one. |
| `redaction` | none | **yes**, `/tmp` tmpfs | Stateless by design and non-root already. It handles the most sensitive text on the box, so it gets the strictest posture of the three optional profiles. |
| `mail` | **none** | no | See below. |
| `mail-tls-sync` | `CHOWN` | **yes** | It copies two PEM files into the mail volume and chowns them to the mail user. |

### The mail service needs no capability

It is the service to think hardest about: internet-facing, and the host
publishes port 25 at it. It still drops everything, because **the privileged
port is on the host side of the port mapping**: inside the container Haraka
binds 2525 as the image's non-root `node` user, and Docker forwards 25 to it.
Granting `NET_BIND_SERVICE` there would be cargo cult.

It is not read-only, and that is deliberate rather than lazy: the entrypoint
writes `host_list`, `me`, `databytes`, `tls.ini` and the generated DH parameters
into its config directory at start, and Haraka writes its queue. A read-only
root would break STARTTLS specifically, which is the path that fails quietly
(see [`../operations/email-inbound.md`](../operations/email-inbound.md)).

### What "verified" means here

The hardened stack was brought up from empty volumes with the mail, research,
redaction and consoles profiles on, and real work was put through it: a PDF
ingested to verified facts, an image-only PDF forced onto the **OCR** tier of
the reading ladder (the most temp-file-hungry path there is, and it works under
a read-only root), a managed embedding rebuild, inbound mail refused and then
accepted through the allowlist into extracted facts, a research run from
proposal to captured pages, a grounded chat answer with the redaction sidecar
enabled and fail-closed, a source deleted to a confirmed signed receipt with the
chain verifying, the integrity sweep, `reindex` through `compose run`, and a
backup-shaped `tar` read of every volume.

One consequence worth knowing before debugging: with a read-only root you cannot
write a scratch script into `/repo` inside the app or worker container. Write it
to `/tmp` (a tmpfs) and pipe it in, for example
`docker compose exec -T app node < script.js`.

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
- Container privilege: both compose files (`cap_drop` / `cap_add` /
 `security_opt` / `read_only` / `tmpfs`), asserted by
 `project/src/entrypoints/deployment-hardening.spec.ts`
- Operator tooling coverage: `scripts/ci/operator-smoke.sh` (what it does and
 does not cover is documented in the file itself)
- Logging redaction: `project/src/entrypoints/logger.ts`
- Edge config: `project/infra/deploy/Caddyfile`
