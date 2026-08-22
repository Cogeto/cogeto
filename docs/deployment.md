# Deploying Cogeto

This page states the deployment *model* and the commands you'll want at hand.
The operator script itself is documented in
[`operations/operator-script.md`](operations/operator-script.md), and the
per-task procedures (adding users, inbound email, upgrades) are in
[`operations/`](operations/).

## First, the thing people get wrong

**There are two compose files in this repository and only one of them is a
deployment.**

`docker-compose.yml` at the repository root is the **development stack**. It
exists so a clone runs with zero configuration on `localhost`: it BUILDS images
from the working tree, and every secret it needs has a committed default, from
the Postgres password to the `admin@cogeto.localhost / DevPassword1!` bootstrap
login. Those values are public, so a copy of that stack reachable from the
internet is a copy anyone can sign into. A secret preflight refuses to boot
with a known dev secret once the configured domain is not localhost, but do not
lean on that: it reads a configuration value, not the network.

`project/infra/deploy/docker-compose.deploy.yml` is the **deployment stack**. It
never builds, it requires every secret (`${VAR:?}`, so a missing one refuses to
start), and it is not meant to be run by hand. **You do not deploy Cogeto by
running a compose file.** You run `cogeto install`, which fetches that compose
file at the matching release tag, generates the secrets, verifies the image
signatures and starts the stack for you.

So: **`docker compose up` is how you evaluate Cogeto on your own machine.
`cogeto install` is how you run one.** Nothing in this document describes a
supported path where the first becomes the second.

## The model: pull-only, signed, single-tenant

- **One instance = one customer.** Isolation is a deployment boundary, not a row filter. There is no multi-tenant mode.
- **A production instance never builds.** It pulls prebuilt images per release,
 each **cosign-signed** by the release pipeline:

 | Image | Contents | When |
 | --- | --- | --- |
 | `cogeto/cogeto:<version>` | app / worker / migrate / preflight | always |
 | `cogeto/cogeto-edge:<version>` | Caddy edge with the built SPA | always |
 | `cogeto/cogeto-mail:<version>` | the receive-only inbound SMTP service | with the `mail` capability |
 | `cogeto/cogeto-redaction:<version>` | the local PII redaction sidecar | with the `redaction` capability |

- The deployment compose + production Caddyfile live in
 [`project/infra/deploy/`](../project/infra/deploy/) and are fetched at the
 release tag matching the image version. Secrets are generated per instance,
 required by the compose file (`${VAR:?}`), and never committed.
- Everything is orchestrated by **one operator script**,
 [`scripts/operator/cogeto`](../scripts/operator/cogeto). It installs cosign
 and verifies the signatures itself, and ends every run with an
 instance-specific checklist of what it cannot do for you (DNS records, backup
 settings, verification steps). The complete subcommand set, which is what
 `cogeto --help` prints:

 | Subcommand | What it is for |
 | --- | --- |
 | `install` | First-time setup on a fresh Ubuntu 22.04/24.04 host |
 | `configure` | Show or change instance configuration: `--domain`, `--regenerate NAME`, `--mail-tls-mode automatic\|operator` |
 | `upgrade` | Move to a published release, or roll images back |
 | `status` | The honest health report; the first command in any investigation |
 | `features` | Optional capabilities: list, enable, disable |
 | `reindex` | Rebuild the vector index from Postgres, or move the embeddings model |
 | `backup-info` | The exact hosting-panel settings to enable |

 Global flags: `--check` (dry run, mutates nothing), `--root DIR`, `--help`.

```sh
# On a fresh Ubuntu 22.04/24.04 instance:
curl -fsSL https://raw.githubusercontent.com/Cogeto/cogeto/main/scripts/operator/cogeto -o cogeto
chmod +x cogeto
sudo ./cogeto install --check --domain <your.domain> --acme-email <you> # dry run first
sudo ./cogeto install --domain <your.domain> --acme-email <you>
```

After first login, configure a model provider in the interface (Providers in the
gear menu, /instance/providers); the printed checklist says so.

### How the deployment files arrive

The files that define the stack (the compose file, the production Caddyfile,
the Zitadel bootstrap script, the Postgres role provisioning, the SearXNG
settings) are **not** fetched from the repository. `install` and `upgrade`
download one artifact from the release of the exact version being installed,
`cogeto-deploy-assets-X.Y.Z.tar.gz`, and verify it twice: against the sha256
the release publishes as a separate asset (and in its notes), and then file by
file against the checksum manifest carried inside the tarball. Nothing is
installed until every file has passed, and the artifact's own `VERSION` entry
must match the version being installed.

Five failures, five different messages, because the right response differs:

| The script says | What it means | What to do |
| --- | --- | --- |
| `DEPLOY ASSETS: RELEASE UNREACHABLE` | the download did not complete | a network, DNS, proxy or GitHub problem. Nothing changed. Retry is safe |
| `DEPLOY ASSETS: ARTIFACT MISSING FROM THE RELEASE` | that release publishes no artifact | either a release older than this mechanism (use the operator script from its own tag) or an incomplete publication. Retrying cannot help |
| `DEPLOY ASSETS: OUTER CHECKSUM MISMATCH` | the bytes are not the ones published | stop. Corrupted in transit, or not this release's artifact. Compare against the checksum on the release page |
| `DEPLOY ASSETS: VERSION MISMATCH` | the artifact belongs to another version | stop and report it. Nothing was installed |
| `DEPLOYMENT FILE CHECKSUM MISMATCH` | a file inside disagrees with the manifest inside | stop and report it. Nothing was installed |

How the artifact is produced, and the contract the shape carries for anything
automating installs: [`release-process.md`](release-process.md).

TLS is automatic (Let's Encrypt via Caddy) as soon as the printed DNS records
resolve. The runbook's cloud-panel steps map
one-to-one to any provider's DNS/PTR/firewall equivalents.

## Verifying a release image

Every release image is signed with keyless cosign (Sigstore, GitHub OIDC, no
long-lived keys). Verify any of them at any time:

```sh
cosign verify cogeto/cogeto:<version> \
 --certificate-identity-regexp '^https://github.com/Cogeto/cogeto/\.github/workflows/release\.yml@refs/tags/' \
 --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
```

(Substitute `cogeto/cogeto-edge`, `cogeto/cogeto-mail` or
`cogeto/cogeto-redaction` for the others.)
The operator script runs these checks automatically during `install` and
`upgrade`; each GitHub Release also carries the image's SBOM and the exact
verify command. How releases are produced:
[`release-process.md`](release-process.md).

## Upgrades and rollback

```sh
# Re-download first: the installed copy cannot update itself, and only the
# new script backfills any credential a newer compose requires.
curl -fsSL https://raw.githubusercontent.com/Cogeto/cogeto/main/scripts/operator/cogeto -o cogeto
chmod +x cogeto
sudo ./cogeto upgrade # latest published release
sudo ./cogeto upgrade 1.7.2 # a specific published release
```

The script refuses unpublished tags, re-runs migrations, health-checks, and
detects itself when a release changed the embedding model (offering the
reindex). Rollback rolls images back, **migrations are forward-only**; full
data rollback is the runbook's rehearsed backup restore. Details: runbook §6.

## Rebuilding the vector index

Postgres is the source of truth and Qdrant is a rebuildable index, so a
restored backup whose index and configuration disagree is repaired rather than
lost:

```sh
sudo cogeto reindex                                   # rebuild in place, active model
sudo cogeto reindex --provider <label> --model <model> # move the embeddings model
```

Both run a fresh container (`docker compose run --rm worker`, never `exec`), so
they work while app and worker refuse to start, which is when the first form is
usually needed. The interface runs the same managed rebuild from the Models
page. Details: runbook §5c and [`features/models.md`](features/models.md).

## What deployment is *not*

No Terraform, no cloud-API automation, no self-serve provisioning, no
automatic updates, deliberately (roadmap decision D3): one good script run by
a human, for a first cohort where every instance matters. Backups use the
hosting provider's own capability (runbook §5), and restore is **rehearsed,
not assumed**.
