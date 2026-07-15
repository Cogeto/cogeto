# Deploying Cogeto

**The authoritative document for running a customer instance is the
[operator runbook](operator-runbook.md)** — provisioning, install, DNS,
verification, onboarding, backups with a rehearsed restore, upgrades, and
troubleshooting, all checklist-driven. This page states the deployment *model*
and the commands you'll want at hand.

## The model: pull-only, signed, single-tenant

- **One instance = one customer.** Isolation is a deployment boundary
  (decision 0019), not a row filter. There is no multi-tenant mode.
- **A production instance never builds.** It pulls three prebuilt images per
  release, each **cosign-signed** by the release pipeline (decision 0030):

  | Image | Contents |
  | --- | --- |
  | `cogeto/cogeto:<version>` | app / worker / migrate / preflight |
  | `cogeto/cogeto-edge:<version>` | Caddy edge with the built SPA |
  | `cogeto/cogeto-mail:<version>` | the receive-only inbound SMTP service |

- The deployment compose + production Caddyfile live in
  [`project/infra/deploy/`](../project/infra/deploy/) and are fetched at the
  release tag matching the image version. Secrets are generated per instance,
  required by the compose file (`${VAR:?}`), and never committed.
- Everything is orchestrated by **one operator script**,
  [`scripts/operator/cogeto`](../scripts/operator/cogeto)
  (`install` / `configure` / `upgrade` / `status` / `backup-info`, plus a
  `--check` dry run). It installs cosign and verifies the signatures itself,
  and ends every run with an instance-specific checklist of what it cannot do
  for you (DNS records, backup settings, verification steps).

```sh
# On a fresh Ubuntu 22.04/24.04 instance:
curl -fsSL https://raw.githubusercontent.com/Cogeto/cogeto/main/scripts/operator/cogeto -o cogeto
chmod +x cogeto
sudo ./cogeto install --check --domain <your.domain> --acme-email <you>   # dry run first
sudo ./cogeto install --domain <your.domain> --acme-email <you> --mistral-key <key>
```

TLS is automatic (Let's Encrypt via Caddy) as soon as the printed DNS records
resolve. Self-hosters not on OVHcloud: the runbook's OVH panel steps map
one-to-one to any provider's DNS/PTR/firewall equivalents.

## Verifying a release image

Every release image is signed with keyless cosign (Sigstore, GitHub OIDC — no
long-lived keys). Verify any of the three at any time:

```sh
cosign verify cogeto/cogeto:<version> \
  --certificate-identity-regexp '^https://github.com/Cogeto/cogeto/\.github/workflows/release\.yml@refs/tags/' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
```

(Substitute `cogeto/cogeto-edge` / `cogeto/cogeto-mail` for the other two.)
The operator script runs these checks automatically during `install` and
`upgrade`; each GitHub Release also carries the image's SBOM and the exact
verify command. How releases are produced:
[`release-process.md`](release-process.md).

## Upgrades and rollback

```sh
sudo cogeto upgrade            # latest published release
sudo cogeto upgrade 0.9.1      # a specific one
```

The script refuses unpublished tags, re-runs migrations, health-checks, and
detects itself when a release changed the embedding model (offering the
reindex). Rollback rolls images back — **migrations are forward-only**; full
data rollback is the runbook's rehearsed backup restore. Details: runbook §6.

## What deployment is *not*

No Terraform, no cloud-API automation, no self-serve provisioning, no
automatic updates — deliberately (roadmap decision D3): one good script run by
a human, for a first cohort where every instance matters. Backups use the
hosting provider's own capability (runbook §5), and restore is **rehearsed,
not assumed**.
