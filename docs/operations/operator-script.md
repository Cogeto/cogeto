# Operator script

`scripts/operator/cogeto` is the single tool an operator runs by hand on a
fresh OVHcloud Ubuntu instance. These are the developer-facing
notes; the operator-facing lifecycle documentation (per-customer onboarding,
manual trial tracking, OVH backup configuration, rehearsed restore, upgrade
procedure) is the **[operator runbook](../operator-runbook.md)**.

## What it does

| Subcommand | Effect |
| --- | --- |
| `install` | Fresh Ubuntu 22.04/24.04 → running instance: OS/resource preflight, Docker Engine + compose plugin (official apt repo), **cosign** (pinned release binary; signature verification of every image this instance runs, which is three plus the redaction sidecar when that capability is on), **the script itself to `/usr/local/bin/cogeto`**, `cogeto` system user, `/srv/cogeto` layout, deploy assets fetched at the pinned release tag, per-instance secrets into `.env` (600), the derived inbound address (`capture@in.<domain>`), signed-image pull, `docker compose up -d`, health wait, checklist. |
| `configure` | Show config (secret values never printed) or change it: `--domain` (re-derives OIDC issuer, S3 origin, inbound address; typed confirmation), `--regenerate NAME` (six rotatable secrets: `COGETO_MAIL_INTAKE_TOKEN`, `COGETO_QDRANT_API_KEY`, `COGETO_APP_DB_PASSWORD`, `COGETO_MIGRATE_DB_PASSWORD`, `ZITADEL_DB_ADMIN_PASSWORD`, `COGETO_S3_SECRET_KEY`; data-bound secrets and the receipt-signing key are refused by name), `--mail-tls-mode automatic\|operator` (who owns the inbound-mail certificate: `operator` records that the material in the `mail-tls` volume is the operator's own, blanks `COGETO_MAIL_TLS_SITE`, and makes `sync_mail_tls_site` a no-op on every path that would otherwise converge it, so the documented override survives an upgrade; going back asks for a typed confirmation, because the edge then overwrites their files). Model providers are configured in the interface, never here; the flag that once set a model key dies with a message saying so. |
| `upgrade [X.Y.Z\|latest]` | Self-heals the `/usr/local/bin/cogeto` install first (issue #60: a freshly downloaded script run via `upgrade` must leave `sudo cogeto` working). Decides what the instance is on from the **running app image**, not from `COGETO_VERSION` in `.env`, and records the new version only **after** `compose up` succeeds: an upgrade that dies at the pull or the signature check leaves the file telling the truth and is RESUMABLE by re-running the same command (a version written ahead of the work it describes made a failed upgrade look finished and refuse the retry, observed at v1.7.3). A pull, signature or start failure names what failed, what to do, and that nothing changed. Published-tag check (Docker Hub), typed confirmation, fetch matching deploy assets, pull, `compose up -d` (the dependency graph re-runs preflight → migrate before app/worker restart), health check, embedding-model drift check → `reindex` (typed confirmation, it re-embeds via the model API), rollback instructions. Rollback = `upgrade <older>` with a ROLLBACK confirmation; schema stays forward, data rollback is the OVH-backup restore. |
| `status` | Honest report: configured vs actually-running version, per-container health, the app's aggregate `/api/health` (migrations, queue depth, dead-letter count, deletion-sweep state, bucket encryption, mail listener), served TLS certificate + renewal note, **inbound-mail STARTTLS** (probed with a real SMTP handshake, with the certificate's expiry, only when email capture is on), disk usage, `.env` permissions. Green only when green. |
| `features` | Optional capabilities (P6.7). No verb: list the five capabilities the script switches (`redaction`, `research`, `mail`, `demo`, `consoles`) with their configured state from `.env`, then the four the registry reports and the script does NOT switch (`models`, `reasoning`, `vision`, `connectors`) with where each is decided, then, with the stack up, the live registry from `/api/health` (stack down → configured state + "health unknown", honestly). `FEATURE_IDS_REPORTED_ONLY` is the second list and must stay equal to `CapabilityId` minus `FEATURE_IDS`: an operator who sees a capability in health and not here concludes something is broken. Asking to enable one of the four dies with where it IS decided. `enable <id>` / `disable <id>`: idempotent `.env` edits (`COMPOSE_PROFILES` + the capability's flags), `compose up -d --remove-orphans`, per-service health wait, operator TODOs. Typed confirmation: `disable redaction` (plaintext consequence). Models are not a capability and not a script concern: providers, keys and tier assignments live in the interface, and the script knows nothing about them (asking for `local-models` dies with a message pointing at the Providers page). `enable demo` is refused loudly on a production instance; capabilities whose services are not in the instance's compose file (demo/consoles on the deploy channel) are refused with the reason. `enable redaction` pulls and cosign-verifies `cogeto/cogeto-redaction` before starting it, and prints the memory footprint and the retrieval trade-off as TODOs. `enable research` also generates `SEARXNG_SECRET` and fetches `searxng/settings.yml` (pinned to the installed version) when missing. |
| `reindex [--provider LABEL --model MODEL]` | The vector index from the shell (V2.4 item 7.1 second half). Flagless: rebuild the ACTIVE collection in place from Postgres with the active embeddings model, the repair for the mismatch the boot guard refuses (restored backup, direct database edit). With `--provider` and `--model`: move the instance to a different embeddings model via the same managed rebuild the interface runs (new collection beside the serving one, switch only on verified completion, interruption resumes). Typed `REINDEX` confirmation both ways (re-embedding costs model API calls). Uses `compose run --rm worker`, so it works while app and worker crash-loop; shares the application's own engine rather than duplicating it. |
| `backup-info` | The exact OVHcloud panel settings to enable(the script performs no backups). |

Global: `--check` (dry run, validates prerequisites, prints intended actions
and the checklist, mutates nothing; exit 0), `--root DIR` (default
`/srv/cogeto`), `--help`. Every run ends with the delimited
**WHAT YOU MUST DO NOW** checklist, grouped *do now* / *verify after DNS
propagates* / *record in your vault*, with real instance values (detected
public IP, derived MX records): never placeholders.

## The deploy channel

The instance pulls three cosign-signed images per release
(`cogeto/cogeto`, `cogeto/cogeto-edge`, `cogeto/cogeto-mail`), plus
`cogeto/cogeto-redaction` when that capability is on, and fetches
`project/infra/deploy/{docker-compose.deploy.yml,Caddyfile}` plus
`project/infra/docker/zitadel-init/init.mjs` from the matching `vX.Y.Z` tag.
See the deploy [README](../../project/infra/deploy/README.md) for the hardening rules. The script carries **no version
constants**: it resolves the newest GitHub release not flagged pre-release,
confirms it with the operator, and refuses retired (pre-release-flagged) or
unpublished versions. Retire a release with
`gh release edit vX.Y.Z --prerelease`, effective immediately, no script
edit, nothing to bump in release PRs.

## Testing

- CI `lint` runs `shellcheck scripts/operator/cogeto`: keep it clean, and
 keep the script bash-3.2-compatible (the spec also runs on macOS): no
 associative arrays, no `${var,,}`, no `mapfile`.
- `project/src/entrypoints/operator-script.spec.ts` covers the CLI contract
 (`--help`, argument refusals, the `--check` dry run mutating nothing and
 printing the checklist with real values), the pure helpers (sourcing the
 script executes nothing), and the deploy-channel hardening assertions
 (no `build:` keys, required secrets, digest/CSP consistency with the dev
 stack, all four images published and signed by `release.yml`).
- Secrets must never appear in output: the spec asserts no 64-hex-char token
 leaks from a dry run; keep `env_set` the only place values flow.

## Manual test procedure (real VM)

The runbook's sections 1 to 3 are the authoritative operator flow; the condensed
developer pass on a fresh OVHcloud Ubuntu 24.04 instance is:

1. Copy `scripts/operator/cogeto` to the instance, `chmod +x`.
2. `sudo ./cogeto install --check`: read the plan; nothing changes.
3. `sudo ./cogeto install --domain <instance domain> --acme-email <you>`:
 should reach "stack healthy" in well under an hour end to end (D5 launch
 definition), then follow the printed checklist: add the DNS records it
 prints (two, plus the mail host's A record and the PTR only with email
 capture on), enable the OVH backup.
4. After DNS propagates: HTTPS login works, allowlist a sender, send a test
 email, confirm it lands; export a Passport; delete the test source and
 check Forgotten's receipt; `sudo ./cogeto status` is green.
5. `sudo ./cogeto upgrade <next version>` when available; confirm health and
 the nav-footer version; rehearse `upgrade <previous>` rollback awareness.

## Known limits (deliberate, v1)

- Single-instance, single-tenant only: no fleet operations (D3: manual until
 onboarding is the bottleneck, post-2.0).
- Dreaming last-run is not surfaced by `status` (not cheaply available via
 `/api/health`); the dashboard System panel remains the place to check it.
