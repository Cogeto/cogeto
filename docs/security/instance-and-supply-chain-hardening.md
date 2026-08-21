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
- **Deployment files arrive as one checksummed release artifact.** The compose
 file, the production Caddyfile, the Zitadel bootstrap script, the Postgres
 role provisioning and the SearXNG settings used to be fetched file by file
 from the repository (originally at a tag ref, which is mutable, then at the
 immutable commit the tag pointed at). They now arrive as a single tarball
 attached to that version's GitHub Release,
 `cogeto-deploy-assets-X.Y.Z.tar.gz`, verified at two levels: the **outer
 sha256** published as its own release asset and in the release notes, so the
 value can be obtained without downloading the thing it verifies, and the
 **per-file manifest** (`project/infra/deploy/deploy-assets.sha256`) carried
 INSIDE the tarball, against which every file is verified before any of them
 is installed. The artifact also carries a `VERSION` entry that must equal the
 version being installed, so the version relationship is stated by the
 download URL and by the artifact itself, and neither is a moving reference.
 A missing artifact, an unreachable release, an outer mismatch, a per-file
 mismatch and a version mismatch each abort the run with their own message,
 because the right response differs: retry, check the network, or stop. The
 manifest is generated from the working tree
 (`node scripts/ci/deploy-assets-manifest.mjs --write`) and a test fails the
 build if it drifts from the files it covers, or if the artifact does not
 carry every file the installer installs. The release workflow verifies the
 artifact before publishing it and re-downloads it afterwards, so a release
 whose deployment assets are missing or malformed fails instead of shipping.

## Per-instance secrets

The operator script generates every secret **locally at install** into a
`600`-permission `.env`, and secrets are never committed, transmitted, or logged
(names are logged, values never). This includes the database and object-store
credentials, the identity-provider admin credentials, the MinIO encryption master
key, and the instance signing key.

Three secrets are load-bearing for the verifiable-memory guarantees and are
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
- **The instance master key** (`COGETO_MASTER_KEY`) encrypts every provider API
 key and every connector credential at rest, AES-256-GCM, in the database. Its
 lifecycle is stated below because it is a boundary rather than a mechanism.

A **secret preflight** refuses to start a non-localhost deployment that is still
using a known development secret value, so a stack cannot accidentally go live with
a demo password or the compose file's clearly-marked dev-only defaults.

### The instance master key: generated once, never rotated

This is a stated limit, not an omission, and it is written here so nobody has
to discover it during an incident.

**What it is.** `COGETO_MASTER_KEY` lives in the environment and nothing else;
what it protects lives in the database and nothing else. That split is the
whole design: a database dump, a backup, a replica or a support export contains
ciphertext, and the one thing that opens it is not in there with it. Every
sealed column is opened in exactly one function, and a confinement test asserts
that structurally rather than by review.

**It is generated once and does not rotate.** The operator script writes it at
install and never regenerates it; `cogeto configure --regenerate` rotates the
database and object-store credentials and deliberately leaves this one alone.
There is no re-sealing tool and none is planned: rotating the key means
re-encrypting every sealed value under the new one, and the honest alternative
is available and cheap, which is to re-enter the provider keys.

**What a compromise means, plainly.** If the master key leaks, every provider
API key and connector credential the instance holds must be treated as
disclosed. The response is to **reissue those credentials at the provider**
(revoke the API keys in the Mistral, OpenAI, Anthropic or Atlassian console,
issue new ones) and to **rebuild the instance** with a fresh key, re-entering
the new credentials through the Providers and Connections pages. The memory
corpus itself is not encrypted under this key and is unaffected; what is lost
is the confidentiality of the rented-model credentials, not of the knowledge.

**What a stolen worker credential reaches.** The worker process holds the
master key AND the receipt-signing private key. An attacker with code
execution in the worker container therefore has every provider credential in
the clear, and the ability to mint deletion receipts that verify against the
published public key. That is the worst position in this system and it is
stated rather than implied.

**The application process is deliberately kept away from both.** The app
container mounts only the PUBLIC half of the signing keypair (`instance-pubkey`,
read-only) and cannot sign anything; the identity seam registers the decrypting
credential opener only when a composition root asks for it, and only the worker
root does, so a request-path service that tried to read a credential would fail
at boot rather than succeed at runtime. The app is the process exposed to the
internet; the split means compromising it does not yield either key.

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
 `stage_deploy_artifact`, `install_asset`), `scripts/ci/deploy-assets-manifest.mjs`,
 `scripts/ci/deploy-artifact.mjs`, `project/src/entrypoints/deploy-artifact.spec.ts`
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
