# Operator script — developer notes (Session O6)

`scripts/operator/cogeto` is the single tool an operator runs by hand on a
fresh OVHcloud Ubuntu instance ([decision 0030](../decisions/0030-operator-script-and-deploy-channel.md);
roadmap [D3](../Cogeto-v1-Roadmap-Revision.md)). These are the developer-facing
notes; the operator-facing runbook (per-customer onboarding, manual trial
tracking, OVH backup configuration, rehearsed restore, upgrade procedure) is
**Unit B** and does not exist yet.

## What it does

| Subcommand | Effect |
| --- | --- |
| `install` | Fresh Ubuntu 22.04/24.04 → running instance: OS/resource preflight, Docker Engine + compose plugin (official apt repo), `cogeto` system user, `/srv/cogeto` layout, deploy assets fetched at the pinned release tag, per-instance secrets into `.env` (600), the derived inbound address (`capture@in.<domain>`), signed-image pull (+ cosign verify when cosign is present), `docker compose up -d`, health wait, checklist. |
| `configure` | Show config (secret values never printed) or change it: `--domain` (re-derives OIDC issuer, S3 origin, inbound address; typed confirmation), `--mistral-key`, `--regenerate NAME` (only `COGETO_MAIL_INTAKE_TOKEN` and `COGETO_QDRANT_API_KEY`; data-bound secrets and the receipt-signing key are refused — see decision 0030 ruling 3). |
| `upgrade [X.Y.Z\|latest]` | Published-tag check (Docker Hub), typed confirmation, fetch matching deploy assets, pull, `compose up -d` (the dependency graph re-runs preflight → migrate before app/worker restart), health check, embedding-model drift check → `reindex` (typed confirmation — it re-embeds via the model API), rollback instructions. Rollback = `upgrade <older>` with a ROLLBACK confirmation; schema stays forward — data rollback is the OVH-backup restore. |
| `status` | Honest report: configured vs actually-running version, per-container health, the app's aggregate `/api/health` (migrations, queue depth, dead-letter count, deletion-sweep state, bucket encryption, mail listener), served TLS certificate + renewal note, disk usage, `.env` permissions. Green only when green. |
| `backup-info` | The exact OVHcloud panel settings to enable (roadmap D4 — the script performs no backups). |

Global: `--check` (dry run — validates prerequisites, prints intended actions
and the checklist, mutates nothing; exit 0), `--root DIR` (default
`/srv/cogeto`), `--help`. Every run ends with the delimited
**WHAT YOU MUST DO NOW** checklist, grouped *do now* / *verify after DNS
propagates* / *record in your vault*, with real instance values (detected
public IP, derived MX records) — never placeholders.

## The deploy channel

The instance pulls three cosign-signed images per release —
`cogeto/cogeto`, `cogeto/cogeto-edge`, `cogeto/cogeto-mail` — and fetches
`project/infra/deploy/{docker-compose.deploy.yml,Caddyfile}` plus
`project/infra/docker/zitadel-init/init.mjs` from the matching `vX.Y.Z` tag.
See the deploy [README](../../project/infra/deploy/README.md) and decision
0030 for the hardening rules. **The oldest installable release is 0.9.0** —
earlier tags never published the edge/mail images.

`DEFAULT_VERSION` at the top of the script is the pinned known-good release.
**Bump it in each `chore: release vX.Y.Z` PR** once that release is verified
on a real instance.

## Testing

- CI `lint` runs `shellcheck scripts/operator/cogeto` — keep it clean, and
  keep the script bash-3.2-compatible (the spec also runs on macOS): no
  associative arrays, no `${var,,}`, no `mapfile`.
- `project/src/entrypoints/operator-script.spec.ts` covers the CLI contract
  (`--help`, argument refusals, the `--check` dry run mutating nothing and
  printing the checklist with real values), the pure helpers (sourcing the
  script executes nothing), and the deploy-channel hardening assertions
  (no `build:` keys, required secrets, digest/CSP consistency with the dev
  stack, all three images published and signed by `release.yml`).
- Secrets must never appear in output — the spec asserts no 64-hex-char token
  leaks from a dry run; keep `env_set` the only place values flow.

## Manual test procedure (real VM — for the Unit B runbook)

Until the runbook lands, the manual pass on a fresh OVHcloud Ubuntu 24.04
instance is:

1. Copy `scripts/operator/cogeto` to the instance, `chmod +x`.
2. `sudo ./cogeto install --check` — read the plan; nothing changes.
3. `sudo ./cogeto install --domain <instance domain> --acme-email <you>` —
   should reach "stack healthy" in well under an hour end to end (D5 launch
   definition), then follow the printed checklist: add the four DNS records,
   set the PTR, enable the OVH backup.
4. After DNS propagates: HTTPS login works, allowlist a sender, send a test
   email, confirm it lands; export a Passport; delete the test source and
   check Forgotten's receipt; `sudo ./cogeto status` is green.
5. `sudo ./cogeto upgrade <next version>` when available; confirm health and
   the nav-footer version; rehearse `upgrade <previous>` rollback awareness.

## Known limits (deliberate, v1)

- Single-instance, single-tenant only — no fleet operations (D3: manual until
  onboarding is the bottleneck, post-2.0).
- No redaction profile on customer instances (its image is not published);
  enable it as a dev-profile deployment if a design partner requires it.
- STARTTLS for inbound SMTP is not terminated by the stack (the Haraka
  listener speaks plain SMTP behind port 25, per the O4 notes); senders that
  require TLS-only delivery are a Unit B/hardening follow-up
  (`docs/notes/email-inbound.md` documents the two supported patterns).
- Dreaming last-run is not surfaced by `status` (not cheaply available via
  `/api/health`); the dashboard System panel remains the place to check it.
