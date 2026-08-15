# Deploying Cogeto

**The authoritative document for running a customer instance is the
[operator runbook](operator-runbook.md)**, provisioning, install, DNS,
verification, onboarding, backups with a rehearsed restore, upgrades, and
troubleshooting, all checklist-driven. This page states the deployment *model*
and the commands you'll want at hand.

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
left rail); the printed checklist says so.

TLS is automatic (Let's Encrypt via Caddy) as soon as the printed DNS records
resolve. Self-hosters not on OVHcloud: the runbook's OVH panel steps map
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
