# Deployment readiness audit

Scope: could a customer instance be deployed and operated today, securely and
correctly, by someone following only what is in this repository? Read-only
audit against the working tree at `42dc6ff` (v1.6.0), 2026-08-13. Evidence is
file:line, command output, or observed behaviour on the running dev stack.
Nothing was changed; this report is the only file written.

---

## Executive summary

**A fresh customer instance can be deployed today. An existing one cannot be
upgraded**, and that is the blocker: `cogeto upgrade` never backfills
`COGETO_MASTER_KEY`, while v1.6.0's provider seed throws at boot when the
environment holds a provider key and no master key. Every pre-v1.6.0 instance
has `COGETO_MISTRAL_API_KEY` in `.env` by construction, so every one of them
crash-loops on upgrade; `upgrade-notes.md:68` claims the opposite. The second
theme is that the operator script and runbook still speak the pre-v1.6.0
language of environment-configured models, so the documented recovery for
"model features are off" silently does nothing.

Counts: **1 BLOCKER, 6 HIGH, 9 MEDIUM, 6 LOW** (22 findings). Top three: F1
(upgrade takes an instance down), F2 (the documented model-key recovery is a
no-op), F4 (the mail STARTTLS procedure needs a certificate that is never issued
and a compose file that does not exist on the instance). **All twenty-two are
resolved across six remediation waves; see the status sections below.** F13 and
F14, the last two, were the owner-decision pair: the owner's ruling was that the
translations must be there and must work, so wave 6 finished them rather than
gating the language picker. The coverage gap recorded in Part 6, that nothing
exercised the operator script, is closed in wave 5.

### Remediation status, wave 6 (2026-08-15, `fix/i18n-completion`)

The internationalisation pair, F13 and F14, and the guard gap that let both
survive. The owner's ruling on F14 was explicit: **the translations must be
there and must work properly; gating the language picker is not the answer.**

| Finding | Status |
|---|---|
| F13 | **Resolved, by codes rather than by server-side translation.** Every HTTP failure the server raises now goes through one of two factories in `infrastructure/api-error.ts`. `userError` carries a stable `code` and its interpolation `params` alongside the unchanged English `message`, and the interface renders its own translation of that code; `untranslatedError` declares the opposite, for the three cases where nothing can be translated (a developer error, a machine client, or text we did not write). 134 codes across 218 sites; 40 sites are declared untranslatable with the reason. The rationale for codes over the server catalogue is in [`../features/i18n.md`](../features/i18n.md#server-errors-are-codes-not-sentences), and the deciding evidence was in this codebase already: most of these throws have no `Principal` in scope, and the quota failures had reached for a `code` field years before this. The interface stopped rendering raw server text at all 35 sites the report named, and degrades to the server's own sentence for a code it has no key for, never to a bare code and never to an empty string. |
| F14 | **Resolved by finishing the work.** All three locales are complete: 1933 values in `de`, 2015 in `fr` and `hr` (the extra are the CLDR plural categories those languages need and English does not), with 112 values identical to English by design and each one listed. Terminology is fixed in a per-locale glossary in [`../features/i18n.md`](../features/i18n.md#terminology) so a future translator inherits the decisions. 57 plural `_one` forms that `i18n:add` had seeded from the English `_other` were also wrong and are fixed; nothing had been watching them. |
| Guard gap (Part 2) | **Closed.** The literal scan is no longer fenced to `project/web/src`. On the server it is now EXACT rather than heuristic: constructing a Nest exception outside `api-error.ts` fails the build, and the `serverErrors` namespace is held to the throw sites in three directions (no code without a key, no key without a code, no English drift). A completeness check fails the build on any value that is still its English source, with the count printed per locale on success. The SPA literal detector dropped from three words to two. Every category is proved by breaking it: `i18n-guard.spec.ts` copies the repository, introduces one deliberate regression per category, and asserts the real script fails naming the offence. |

**No behaviour changed and no English source string was reworded.** Three
sentences gained a `_one` plural form English never had (a count-bearing message
reads wrongly at 1 in every language, and Croatian needs three forms to be
grammatical at all); nine bare `NotFoundException()` sites that answered "Not
Found" gained a real sentence, because F13's whole point is that a person must
not read English error text. Both are listed in the pull request.

### Remediation status, wave 5 (2026-08-15, `fix/hardening-and-coverage`)

The infrastructure and process remainder: container privilege, the last abuse
limit, the housekeeping, and the coverage gap Part 6 recorded. **Every finding
below was closed against the code as it stands after waves 1 to 4, not against
this report.**

| Finding | Status |
|---|---|
| F11 | **Resolved.** Every service in both compose files drops ALL capabilities and sets `no-new-privileges`. What each service gets back is per service and verified by running real work through the stack rather than by watching it start: `NET_BIND_SERVICE` for the two edges, `CHOWN` for the three volume-ownership one-shots, `DAC_OVERRIDE` for `zitadel-init` (root does not bypass directory permissions on a volume owned by uid 1000), the five the Postgres entrypoint needs to drop privileges, and four for SearXNG's entrypoint. **The mail service, the internet-facing one, needs none**: the privileged port is on the host side of the port mapping and Haraka binds 2525 as a non-root user inside. Eleven services also run on a **read-only root** with an explicit tmpfs, including the app and the worker. Two exceptions are recorded with their reason in the file itself: Qdrant **panics** under a read-only root (measured, not assumed), and the mail service writes its own config directory at start, where a read-only root would break STARTTLS specifically. The full table, and what "verified" meant, is in [`../security/instance-and-supply-chain-hardening.md`](../security/instance-and-supply-chain-hardening.md); `deployment-hardening.spec.ts` asserts the drop on every service and pins the exact grant list, so a new capability has to be argued for in review. |
| F12 | **Resolved, in both places the report offered.** The preflight now refuses an ACTIVE profile whose required secret is EMPTY, which the known-dev-secret pass structurally cannot see (it skips empty values by design). The active profile list is passed into the preflight container for exactly this, since a container cannot read its own profiles. It applies on localhost too: the dev compose supplies a working default, so an empty value is deliberate. The SearXNG healthcheck carries the same refusal, which also covers a `docker compose up searxng` that never runs the preflight. The profile-inactive case the empty default exists to serve is unchanged and asserted. Verified live: with the research profile active and the secret blanked, `compose up` fails at the preflight naming `SEARXNG_SECRET`. |
| F17 | **Resolved.** `eval/trust-scores/file` is deleted. Nothing referenced it. |
| F18 | **Confirmed and tightened further.** The tag-comment guard was already closed in wave 2. It read a hardcoded list of files, which covers the files that existed when it was written; it now DISCOVERS every Dockerfile in the repository. Verified negatively by removing a tag comment and watching the check fail. |
| F20 | **Confirmed dead.** The unprefixed `MISTRAL_*` names appear nowhere in the tree outside the structural guard that forbids them (`model-config-env.spec.ts`), which asserts both the behaviour (a stale variable changes nothing) and the confinement (only the eval harness's own resolver may name the `COGETO_`-prefixed forms, because it runs in CI against no instance database). Nothing survived deliberately. |
| Part 6 coverage gap | **Closed.** `scripts/ci/operator-smoke.sh` runs the operator script against a real stack in CI: `operator-smoke-fast` on every pull request (the dry-run install, the printed checklist, a no-retired-mechanism scan over everything the script prints, and the secret backfill that F1 was), and `operator-smoke-full` on merges to main and on demand (a real install from empty volumes onto the deploy compose, every required secret asserted present, `status` asserted against the running containers rather than the environment file, the capability list asserted equal to what `/api/health` reports, enable and disable of an optional capability, and the F12 refusal). What it cannot cover is stated in the file: DNS, certificate issuance, real mail delivery, the release supply chain, and a cloud provider's console. |

Beyond the findings: the production image no longer carries the evaluation
harness (`eval`, `eval-chat` and their two support modules) or the two smoke
tools. They are npm-script and CI tools whose corpora are not in the image, so
on a customer instance they were a tool that reads as supported and is not. The
demonstration corpus (32 KB) **stays**, with the reason recorded in the
Dockerfile: the worker's scheduled sandbox reset reads it, and the sandbox runs
the worker from this stage. The two documented one-shot repair tools stay,
because the runbook tells an operator to run them. A documentation **link**
guard joined `lint` beside the dash guard: the one broken link this report found
by hand was already fixed, and nothing was watching for the next one.

### Remediation status, wave 3 (2026-08-14, `fix/documentation-truth`)

The documentation findings, closed against the code as it stands after waves 1
and 2 rather than against this report: several of the instructions the audit
quoted had already been overtaken, and a few documents had become wrong in ways
this report could not have seen. **Documentation only**, plus `.env.example` and
the operator script's own printed text; no behaviour changed.

| Finding | Status |
|---|---|
| F8 | **Resolved.** The runbook's local-runtime section was already interface-first after wave 1; what remained wrong was its verification command, which called `r.text` instead of `r.text()` and could never run. It is now a runnable block (verified live against the dev stack), preceded by the container-networking fact that actually trips people up: `localhost` inside the app container is the container, not the VM. |
| F9 | **Resolved.** `upgrade-notes.md` no longer contains the superseded `docker compose exec worker npm run reindex` anywhere; every mention across the repository is the `run --rm` form, matching the boot guard's own message. The operator script's two stale `exec` TODOs went with the code that printed them in wave 1. The file's cross-reference to the runbook's upgrade procedure was also wrong (section 5, which is backups); it now says section 6. |
| F10 | **Resolved.** The restore step no longer names a record count. It states which records always exist (the app domain and `s3.<domain>`) and which exist only with email capture on (the `mail.<domain>` A record and the PTR), and points out that the MX record names a hostname rather than an address, so it does not change at all. |
| F15 | **Resolved.** `cogeto features` prints all nine capabilities the registry reports: the five it switches with their configured state, then `models`, `reasoning`, `vision` and `connectors` with where each IS decided, so a capability visible in health is never invisible in the script. `features enable <one of the four>` dies naming the interface page or the probe instead of "unknown capability". `FEATURE_IDS_REPORTED_ONLY` carries the second list and is documented as having to equal `CapabilityId` minus `FEATURE_IDS`. The runbook's list is replaced by the same two groups plus a table of where the four come from, and `features/capabilities.md`'s registry table gained the missing `connectors` row and now states that it explains the entries rather than being the source of the list. |
| F16 | **Resolved.** `docs/deployment.md` carries the complete subcommand table (all seven plus the global flags), matching the script's header comment and `usage()` exactly, and gained a **Rebuilding the vector index** section, since `reindex` is the documented repair for a restored backup and an operator had no reason to discover it there. |
| F19 | **Resolved.** Both variables are documented in `.env.example` with their defaults and, more usefully, with what those defaults mean: the machine user is the one an operator opens in the Zitadel console to mint a replacement token, and the state file sits beside `pat.txt` in the `zitadel-machinekey` volume, which is exactly what the runbook's domain-change procedure manipulates. That procedure's command shape was verified live. |
| F22 | **Resolved.** The "Upgrading past 2.0" section is deleted rather than renamed: there is no such release line, and migration 0035's guard cannot fire on any instance that will ever exist (a fresh database has no `task_conclusion` provenance to strand). The CLI and the guard stay, and `module-boundary-contract.md` records why. The script header, `usage()` and `main()` already agreed on all seven subcommands after wave 2; `docs/deployment.md` is now the third list that matches. |
| F5, F7 | **Documentation halves closed.** Both were resolved in code in wave 2; what remained was that the security document still described redaction's availability as a correction of an earlier error, and the environment example documented the reasoning headroom twice. Availability is now stated once, plainly, in `security/data-sovereignty-and-redaction.md`, with the runbook and `.env.example` pointing at it; the headroom is documented once. |

Beyond the findings, `.env.example` was rewritten as an operator's reference
(what each variable does, its default, whether it is required, and whether the
installer generates it, the operator sets it, or it is a knob to leave alone),
with an explicit list of what is deliberately NOT in it: model configuration,
connector credentials, the compose-fixed addresses, and the developer and CI
tooling.

### Remediation status, wave 2 (2026-08-13, `fix/deploy-channel-parity`)

The deployment path now delivers what the documentation promises. Three
capabilities were documented as available and were not: local PII redaction,
inbound-mail STARTTLS, and several live configuration knobs.

| Finding | Status |
|---|---|
| F4 | **Resolved.** The producing half of the original inbound-TLS design is built. The deploy Caddyfile carries an ACME-only vhost for `{$COGETO_MAIL_TLS_SITE}` (`mail.<domain>`, from the operator script's existing `derive_mx_host`), which falls back to an inert `http://mail-tls-disabled.invalid` placeholder when email capture is off, so an instance without mail orders nothing. A `mail-tls-sync` sidecar (the edge image, `mail` profile, `caddy-data` read-only) copies the certificate into the `mail-tls` volume owned `1000:1000`, only when it changed; the mail entrypoint watches its own copy and exits so compose restarts it with the new material. No Docker socket, no host cron, and it survives an upgrade because it ships in the re-fetched compose file. The dedicated-volume boundary is unchanged and asserted. `cogeto status` reports whether STARTTLS is actually advertised and when the certificate expires; the `mail` capability probe now does an SMTP EHLO instead of a bare TCP connect and names a cleartext posture. The runbook procedure (including its wrong compose filename) is replaced, and the five documents that disagreed now point at one description in `operations/email-inbound.md`, which also documents the operator-supplied-certificate override and the ownership requirement that was the silent trap. |
| F5 | **Resolved.** `cogeto/cogeto-redaction` is built, pushed, cosign-signed and SBOM-attested by the release pipeline exactly like the other three images; the `redaction` profile is in the deploy compose (internal-only, no published port, the dev healthcheck, the 2g ceiling the file's own comment budgets); and `REDACTION_ENABLED` / `REDACTION_URL` / `REDACTION_REQUIRED` are in the shared environment anchor, so both the app and the worker receive them. The operator script's refusal is gone: `features enable redaction` pulls and verifies the image and prints the memory footprint and the retrieval trade-off. The security document and `.env.example` say what is now true. The test fixtures that asserted the opposite (a two-entry profile list, no `redaction:` block) are replaced by assertions encoding the new intent. |
| F6 | **Resolved.** The environment-consistency check is widened on all three axes: it walks `project/src`, `project/web/src`, `project/services/mail`, `project/services/redaction`, `project/infra/docker/zitadel-init` and `scripts/`; it recognises the accessor forms (`read(env, 'NAME')`, the indexed form, the declarative `{ env: 'NAME' }` list, Python `os.environ`, and shell `${NAME}`); and it tracks every prefix in use, not `COGETO_` alone. A new rule catches the class rather than the instances: a variable read by code and passed by the dev compose must be passed by the deploy compose too, unless excepted with a recorded reason. A guard test asserts the widened walk still sees each formerly invisible tree. |
| F7 | **Resolved.** The deploy compose passes `COGETO_MODEL_TIMEOUT_{PIPELINE,ANSWER,EMBEDDINGS,VISION}_MS` and `COGETO_REASONING_HEADROOM`. The duplicate-name situation is resolved by REMOVING the alias: `COGETO_OLLAMA_TIMEOUT_*_MS` is no longer read by `readTimeoutMs`, is gone from both composes, and is inert (asserted). Two names for one setting is how this drift began, and the retired name is the one that describes a runtime the setting stopped being about. |
| F21 | **Resolved.** `COGETO_DEMO_DAILY_UPLOAD_MAX` is removed from the deploy compose, and the absence of the whole `COGETO_DEMO*` family from it is now asserted rather than merely excused by the blanket exception that let this through. |
| F18 | **Resolved incidentally.** The image-pinning guard now fails a digest with NO tag comment, not only one pinned against `:latest`, and the SearXNG digest carries its real tag (`searxng/searxng:2026.7.19-6da6eee26`, resolved from the digest via the Docker Hub tag API; the digest is unchanged). |
| F19 | **Resolved incidentally.** `ZITADEL_BOOTSTRAP_MACHINE_USERNAME` and `ZITADEL_BOOTSTRAP_STATE_FILE` are passed by both composes with the defaults `init.mjs` already used, so the state file's path is knowable without reading the source. Behaviour is unchanged; the widened check surfaced them. |

Not addressed in wave 2: F11 (container privilege hardening), F12 (empty
SearXNG secret), F13/F14 (server-side copy and translation coverage), F17, and
the documentation items, which wave 3 above closes.

### Remediation status (2026-08-13, `fix/model-config-ui-only`)

The environment-based model configuration path was removed entirely: the
interface is the only place models are configured, the one-time seeding bridge
is deleted (the owner ruled no pre-v1.6.0 instance exists or ever will, so it
had nothing to migrate), and an instance with no provider configured is a
normal, honest first-run state.

| Finding | Status |
|---|---|
| F1 | **Resolved.** The seed that threw `MASTER_KEY_MISSING` at boot no longer exists, so the crash-loop precondition is unreachable; independently, `ensure_wave3_secrets` now backfills `COGETO_MASTER_KEY` on upgrade (guarded, never regenerated when set), and the operator spec asserts it. |
| F2 | **Resolved.** `cogeto configure --mistral-key` and `cogeto install --mistral-key` are refused with the pointer at the Providers page; the install checklist's dead model-key step is replaced by the real one (log in, configure a provider in the interface); `cogeto status` reads the model state from the running app's capability registry and can never report a configuration that does not exist. The runbook's troubleshooting row now names the Providers page. |
| F3 | **Resolved.** `cogeto features enable local-models` is gone; the verb is refused with the explanation that a local runtime is an ordinary provider record configured in the interface. The `local-models` capability entry (which keyed off a deleted variable) is removed from the registry; a new `models` entry reports the configuration honestly. |
| F8 | **Resolved.** The runbook's Ollama section describes the interface as the only mechanism (provider record + managed rebuild); no `.env` model edit survives anywhere in the runbook. |
| F20 | **Resolved.** The unprefixed `MISTRAL_*` fallbacks are removed everywhere, including the eval harness's resolver; a structural spec (`model-config-env.spec.ts`) forbids their reappearance. The CI/release workflows now map the `MISTRAL_API_KEY` repo secret into `COGETO_MISTRAL_API_KEY` for the eval jobs. |
| F7 | **Partially resolved here; fully resolved in wave 2 above.** The seed-only halves of the variable families were deleted from both composes, leaving `COGETO_OLLAMA_TIMEOUT_*_MS` as the wired alias. |
| F6 | **Deferred here; resolved in wave 2 above.** The environment-consistency check's structural blind spots were scheduled for the deploy-channel work; noted so they were not forgotten. |

Not examined: cosign verification and Docker Hub tag resolution (need published
release artifacts); a real Ubuntu install run; OVHcloud panel steps; live evals.

---

## Part 1 - Configuration truth

### Is there an environment-consistency check?

Yes: `project/src/entrypoints/env-consistency.spec.ts`, inside the required
`test` CI job. It asserts four things and genuinely checks both directions
(code -> docs, docs -> compose, including the deploy compose). **Its coverage is
narrower than it reads**, three ways, all provable:

| Limit | Evidence |
|---|---|
| Only `COGETO_*` | regex `/(?:process\.)?env\.(COGETO_[A-Z0-9_]+)/g`, line 40. `REDACTION_*`, `ZITADEL_*`, `POSTGRES_*`, `MINIO_*`, `SEARXNG_SECRET` are invisible. |
| Only `env.NAME` syntax | `provider-config.ts` reads through `read(env, 'NAME')` / `readTimeoutMs(env, 'NAME', …)` (lines 276, 403-406, 481). The whole model-gateway variable family is unseen. |
| Only `project/src/**/*.ts` | `SRC = process.cwd()`, line 13. The mail service (`project/services/mail/haraka/plugins/*.js`, `docker-entrypoint.sh`), the redaction service, `project/web`, `scripts/`, and `project/infra/docker/zitadel-init/init.mjs` are all outside the walk. |

Both consequences below (F6, F7) exist precisely inside those blind spots.

### Variable table

`code` = read by any shipped code or entrypoint script; `.env.ex` = present in
`.env.example` (active or commented); `dev` / `deploy` = named in
`docker-compose.yml` / `project/infra/deploy/docker-compose.deploy.yml`; `op` =
handled by `scripts/operator/cogeto`. 166 variables.

| Variable | code | .env.ex | dev | deploy | op | Verdict |
|---|:-:|:-:|:-:|:-:|:-:|---|
| COGETO_ADMIN_ROLE | Y | Y | Y | Y | n | ok |
| COGETO_ADMIN_USER_EMAIL | Y | Y | Y | Y | n | ok |
| COGETO_ANTHROPIC_API_KEY | Y | n | Y | Y | n | legacy seed-only; deliberately removed from .env.example, correct |
| COGETO_ANTHROPIC_BASE_URL | Y | n | Y | Y | n | legacy seed-only; correct by design |
| COGETO_APP_DB_PASSWORD | Y | Y | Y | Y | Y | ok |
| COGETO_ASSERT_NO_PRIVATE_KEY | Y | n | Y | Y | n | internal assertion knob; compose-only |
| COGETO_COMPOSE_PROFILES | Y | n | Y | Y | n | compose-derived; not operator config |
| COGETO_CONSOLES_ENABLED | Y | Y | Y | Y | Y | ok (no consoles service in deploy; flag inert there) |
| COGETO_DAILY_CAPTURE_MAX | Y | Y | Y | Y | n | ok |
| COGETO_DAILY_RESEARCH_PAGES | Y | Y | Y | Y | n | ok |
| COGETO_DAILY_RESEARCH_SEARCHES | Y | Y | Y | Y | n | ok |
| COGETO_DAILY_UPLOAD_MAX | Y | Y | Y | Y | n | ok |
| COGETO_DATABASE_URL | Y | n | Y | Y | n | composed in compose; correct to omit from .env.example |
| COGETO_DEMO_APP_URL | Y | n | Y | n | n | demo-only, correctly absent from deploy |
| COGETO_DEMO_DAILY_CAPTURE_MAX | Y | Y | Y | n | n | demo-only |
| COGETO_DEMO_DAILY_RESEARCH_PAGES | Y | Y | Y | n | n | demo-only |
| COGETO_DEMO_DAILY_RESEARCH_SEARCHES | Y | Y | Y | n | n | demo-only |
| COGETO_DEMO_DAILY_UPLOAD_MAX | Y | Y | Y | n | n | demo-only (F21 resolved: removed from the deploy compose) |
| COGETO_DEMO_DIR | Y | n | n | n | n | test-only, allowlisted |
| COGETO_DEMO_MODE | Y | Y | Y | n | Y | ok |
| COGETO_DEMO_MODEL_DAILY_CALLS | Y | Y | Y | n | n | demo-only |
| COGETO_DEMO_MODEL_DAILY_TOKENS | Y | Y | Y | n | n | demo-only |
| COGETO_DEMO_RATELIMIT_* (4) | Y | Y | Y | n | n | demo-only |
| COGETO_DEMO_RESET_CRON | Y | Y | Y | n | n | demo-only |
| COGETO_DEMO_SESSION_FILE | Y | Y | Y | n | n | demo-only |
| COGETO_DEMO_SSE_MAX_CONCURRENT | Y | Y | Y | n | n | demo-only |
| COGETO_DOWNLOAD_URL_TTL_SECONDS | Y | Y | Y | Y | n | ok |
| COGETO_ENV | Y | Y | Y | Y | n | ok |
| COGETO_EVAL_CACHE / _GATE | Y | n | n | n | n | CI-only, allowlisted |
| COGETO_EXTERNAL_DOMAIN | Y | Y | Y | Y | Y | ok |
| COGETO_EXTRACT_MAX_FACTS | Y | Y | Y | Y | n | ok |
| COGETO_HTTP_PORT | Y | n | Y | Y | n | compose-fixed; ok |
| COGETO_IMPORT_IN_FLIGHT | Y | Y | Y | Y | n | ok |
| COGETO_INSTANCE_KEY_DIR | Y | Y | Y | Y | n | ok |
| COGETO_INSTANCE_PUBKEY_DIR | Y | n | Y | Y | n | compose-only; ok |
| COGETO_INTAKE_URL | Y | n | Y | Y | n | compose-fixed (mail service); ok |
| COGETO_ISSUER / _REDIRECT_URI / _POST_LOGOUT_URI | Y | n | Y | Y | n | compose-derived; ok |
| COGETO_JOBS_OVERDUE_HOURS | Y | Y | Y | Y | n | ok |
| COGETO_LOG_LEVEL | Y | Y | Y | Y | n | ok |
| COGETO_MAIL_ATTACHMENTS_MAX_BYTES | Y | Y | Y | Y | n | ok |
| COGETO_MAIL_ENABLED | Y | Y | Y | Y | Y | ok |
| COGETO_MAIL_HOST / _PORT | Y | n | n | n | n | `scripts/dev/send-test-email.mjs:44` only; dev tool |
| COGETO_MAIL_HOST_PORT | n | Y | Y | Y | n | compose-only by design; ok |
| COGETO_MAIL_INBOUND_ADDRESS | Y | Y | Y | Y | Y | ok |
| COGETO_MAIL_INTAKE_MAX_PER_SENDER | Y | Y | Y | Y | n | ok |
| COGETO_MAIL_INTAKE_RATE_WINDOW_SECONDS | Y | Y | Y | Y | n | ok |
| COGETO_MAIL_INTAKE_TOKEN | Y | Y | Y | Y | Y | ok (`:?` in deploy) |
| COGETO_MAIL_MAX_BYTES | Y | Y | Y | Y | n | ok |
| COGETO_MAIL_REQUIRE_SPF | Y | Y | Y | Y | n | ok |
| COGETO_MAIL_SMTP_ADDRESS | Y | Y | Y | Y | n | ok |
| COGETO_MAIL_TLS_CERT / _KEY | Y | Y | Y | Y | n | ok (F4 resolved: the cert is issued and propagated automatically) |
| COGETO_MAIL_TLS_SITE | n | Y | n | Y | Y | edge-only; set by `features enable mail` from `derive_mx_host` (F4) |
| COGETO_MASTER_KEY | Y | Y | Y | Y | Y | **install generates it; upgrade does not** (F1) |
| COGETO_MIGRATE_DB_PASSWORD | Y | Y | Y | Y | Y | ok |
| COGETO_MIGRATIONS_DIR | Y | Y | Y | Y | n | ok |
| COGETO_MISTRAL_API_KEY | Y | n | Y | Y | Y | **operator script writes it post-seed where it is ignored** (F2) |
| COGETO_MISTRAL_EMBED_MODEL | Y | n | Y | Y | Y | legacy seed-only; read by `check_embedding_model` fallback |
| COGETO_MISTRAL_MODEL_ANSWER / _PIPELINE | Y | n | Y | Y | n | legacy seed-only; correct by design |
| COGETO_MODEL_ANSWER / _PIPELINE / _EMBEDDINGS | Y | n | Y | Y | n | legacy seed-only; correct by design |
| COGETO_MODEL_DAILY_CALLS / _TOKENS | Y | Y | Y | Y | n | ok |
| COGETO_MODEL_GRADER / COGETO_PROVIDER_GRADER | Y | Y | n | n | n | eval-only, allowlisted |
| COGETO_MODEL_TIMEOUT_ANSWER_MS | Y | Y | Y | Y | n | ok (F7 resolved) |
| COGETO_MODEL_TIMEOUT_EMBEDDINGS_MS | Y | Y | Y | **n** | n | same (F7) |
| COGETO_MODEL_TIMEOUT_PIPELINE_MS | Y | Y | Y | **n** | n | same (F7) |
| COGETO_MODEL_TIMEOUT_VISION_MS | Y | Y | Y | **n** | n | same (F7) |
| COGETO_MODEL_VISION / COGETO_PROVIDER_VISION | Y | n | Y | n | n | legacy seed-only; dev-only leftover |
| COGETO_OIDC_EXTERNAL_DOMAIN / _INTERNAL_URL / _ISSUER | Y | n | Y | Y | n | compose-derived; ok |
| COGETO_OLLAMA_API_KEY / _BASE_URL | Y | n | Y | Y | Y | legacy seed-only; `features enable local-models` writes it uselessly (F3) |
| COGETO_OLLAMA_TIMEOUT_*_MS (4) | n | n | n | n | n | RETIRED (F7): the alias is removed from the code and both composes |
| COGETO_OPENAI_API_KEY / _BASE_URL | Y | n | Y | Y | n | legacy seed-only; correct by design |
| COGETO_PARSE_* (6) | Y | Y | Y | Y | n | ok |
| COGETO_PG_POOL_MAX | Y | Y | Y | Y | n | ok |
| COGETO_PRODUCTION | Y | Y | Y | Y | Y | ok (hardcoded `1` in deploy) |
| COGETO_PROMPTS_DIR | Y | Y | Y | Y | n | ok |
| COGETO_PROVIDER_ANSWER / _EMBEDDINGS / _PIPELINE | Y | n | Y | Y | n | legacy seed-only; correct by design |
| COGETO_PROVIDER_PRESET | Y | n | Y | Y | Y | legacy seed-only; written by `features enable local-models` (F3) |
| COGETO_QDRANT_API_KEY | Y | Y | Y | Y | Y | ok (`:?` in deploy) |
| COGETO_QDRANT_URL | Y | n | Y | Y | n | compose-fixed; ok |
| COGETO_RATELIMIT_* (5) | Y | Y | Y | Y | n | ok |
| COGETO_REASONING_HEADROOM | Y | Y | Y | Y | n | ok (F7 resolved) |
| COGETO_REASONING_PROBE_TIMEOUT_MS | Y | Y | Y | Y | n | ok |
| COGETO_REPORT_BRAND_DIR / _FONTS_DIR | Y | Y | Y | Y | n | ok |
| COGETO_RESEARCH_* (6) | Y | Y | Y | Y | n | ok |
| COGETO_ROOT / COGETO_SKIP_RESOURCE_CHECK | n | n | n | n | Y | operator-script-only; undocumented but harmless |
| COGETO_S3_ACCESS_KEY | Y | Y | Y | Y | Y | ok |
| COGETO_S3_BUCKET / _URL | Y | n | Y | Y | n | compose-fixed; ok |
| COGETO_S3_PUBLIC_URL | Y | Y | Y | Y | Y | ok |
| COGETO_S3_SECRET_KEY | Y | Y | Y | Y | Y | ok (`:?` in deploy) |
| COGETO_SEARXNG_URL | Y | Y | Y | Y | n | ok |
| COGETO_SEED_ORG / _OWNER | Y | n | n | n | n | dev seed tool, allowlisted; entrypoint stripped from the image |
| COGETO_SKILL_MAX_QUERIES / _PAGES_PER_QUERY | Y | Y | Y | Y | n | ok |
| COGETO_SSE_* (3) | Y | Y | Y | Y | n | ok |
| COGETO_TIMEZONE | Y | Y | Y | Y | n | ok |
| COGETO_TRUST_SCORES_DIR | Y | Y | Y | Y | n | ok |
| COGETO_UPLOAD_MAX_BYTES | Y | Y | Y | Y | n | ok |
| COGETO_VISION_PAGES_PER_DOCUMENT / _PER_USER_DAILY / _PROBE_TIMEOUT_MS | Y | Y | Y | Y | n | ok |
| COGETO_WEB_CONFIG_FILE | Y | n | Y | Y | n | compose-fixed; ok |
| COGETO_ZITADEL_PAT_FILE | Y | n | Y | n | n | demo-only path; correctly absent from deploy |
| COMPOSE_PROFILES | Y | Y | Y | Y | Y | ok |
| MINIO_BROWSER_REDIRECT_URL | n | Y | Y | n | n | dev console only; ok |
| MINIO_KMS_SECRET_KEY | Y | Y | Y | Y | Y | ok (`:?` in deploy, in the dev-secret refusal list) |
| MINIO_ROOT_PASSWORD / _USER | Y | Y | Y | Y | Y | ok |
| MISTRAL_API_KEY / MISTRAL_MODEL_* / MISTRAL_EMBED_MODEL | Y | n | n | n | n | unprefixed pre-1.0 fallbacks, documented nowhere (F20) |
| POSTGRES_PASSWORD | Y | Y | Y | Y | Y | ok |
| REDACTION_ENABLED | Y | Y | Y | Y | Y | ok (F5 resolved: the profile and the variable are in the deploy channel) |
| REDACTION_REQUIRED | Y | Y | Y | Y | Y | ok (F5 resolved) |
| REDACTION_URL | Y | Y | Y | Y | n | ok (F5 resolved) |
| REDACTION_SPACY_MODEL | n | Y | Y | Y | n | mapped to the sidecar's `SPACY_MODEL`, on both stacks (F5) |
| SEARXNG_SECRET | Y | Y | Y | Y | Y | **defaults to empty in deploy; preflight skips empty** (F12) |
| ZITADEL_ADMIN_PASSWORD / _USERNAME | Y | Y | Y | Y | Y | ok |
| ZITADEL_BOOTSTRAP_MACHINE_USERNAME | Y | n | Y | Y | n | ok (F19 resolved: wired in both composes at its default) |
| ZITADEL_BOOTSTRAP_PAT_EXPIRY | Y | Y | Y | Y | Y | ok |
| ZITADEL_BOOTSTRAP_STATE_FILE | Y | n | Y | Y | n | ok (F19 resolved: wired in both composes at its default) |
| ZITADEL_DB_ADMIN_PASSWORD / _DB_PASSWORD | Y | Y | Y | Y | Y | ok |
| ZITADEL_EXTERNAL_DOMAIN / _INTERNAL_URL / _PAT_FILE | Y | n | Y | Y | n | compose-fixed; ok |
| ZITADEL_MASTERKEY | Y | Y | Y | Y | Y | ok |
| ZITADEL_ORG_NAME | n | Y | Y | Y | Y | ok |

**Nothing that migration 0052 should have removed is still authoritative**: the
model variables remain in both composes and are read only as the one-time seed
source, exactly as `docs/features/models.md:148-152` describes. `.env.example`
already deletes them. The residue is that the *operator tooling* still writes
them (F2, F3).

---

## Part 2 - Internationalisation completeness

**This section records what the audit measured on 2026-08-12 and is left as
written.** F13, F14 and the guard gap it describes are all closed in
[wave 6](#remediation-status-wave-6-2026-08-15-fixi18n-completion); the numbers
below are the before half of that comparison, not the current state.

### Locale completeness

`project/web/src/locales`: 26 namespaces, **1553 English keys**.
`project/src/infrastructure/locales`: 4 namespaces, **223 English keys**.
Missing keys: **0** in every locale (the CI guard is real). "Extra" keys in
`hr`/`fr` are the correct locale-specific CLDR plural categories (`_few` for
Croatian, `_many` for French), not orphans.

| Root | Locale | Keys | Missing | Still literal English | % English |
|---|---|---:|---:|---:|---:|
| web | de | 1553 | 0 | 695 | 44.8% |
| web | fr | 1627 | 0 | 710 | 43.6% |
| web | hr | 1627 | 0 | 693 | 42.6% |
| server | de | 223 | 0 | 186 | 83.4% |
| server | fr | 227 | 0 | 186 | 81.9% |
| server | hr | 227 | 0 | 186 | 81.9% |

Per-namespace English residue (SPA), the surfaces that are effectively untranslated:

| Namespace | en keys | hr=en | de=en | fr=en |
|---|---:|---:|---:|---:|
| sources | 315 | 233 | 232 | 237 |
| providers | 115 | 113 | 113 | 113 |
| connections | 103 | 101 | 101 | 101 |
| projects | 35 | 35 | 35 | 35 |
| reports | 32 | 32 | 32 | 32 |
| extraction | 31 | 31 | 31 | 31 |
| chat | 121 | 50 | 49 | 54 |
| memories | 116 | 39 | 39 | 44 |
| system | 81 | 14 | 14 | 14 |
| capabilities | 56 | 13 | 13 | 13 |
| dashboard | 56 | 6 | 6 | 7 |
| settings | 57 | 9 | 9 | 10 |
| all other namespaces (14) | 335 | 27 | 29 | 32 |

Remaining translation effort: **~693 hr / 695 de / 710 fr SPA strings plus 186
server strings each**. Six namespaces (631 keys, 41% of the SPA) are 100% or
near-100% English in all three locales.

### What the key-sync check does and does not catch

`scripts/ci/check-i18n.mjs` runs inside `lint` and **does** catch: missing keys,
namespace drift, missing CLDR plural categories per locale's own rules, dropped
`{{placeholder}}`/`<tag>`, em/en dashes in English values, unused keys, source
drift when English is reworded (via `.translations.json`), and the common
hardcoded-JSX-text shape.

It **does not** catch, verified:

- **Server-side user-visible text.** Its literal scan is fenced to
  `project/web/src` (line 344). There are **197** `BadRequest/NotFound/
  Forbidden/ConflictException('…')` sites in `project/src` with hardcoded
  English (e.g. `'a source cannot be a revision of itself'`), and the SPA
  renders a raw `error.message` verbatim at 35 sites (`Settings.tsx:1470`,
  `Reports.tsx:80`, `Chat.tsx:871`, `SourceDrawer.tsx:248`, …). `serverT` is
  used at only 20 call sites. See F13.
- **Single-word literals** ("Save", "Cancel") and text built from variables,
  both stated honestly in the file's own comment.
- **Anything outside the SPA and the two locale roots.**

Checked and clean, so not findings: date/number/byte formatting is centralised
in `project/web/src/i18n/format.ts` and always passes the active locale to
`Intl` (no bare `toLocaleDateString()` remains anywhere); no site sends a
translated label to an API or compares one as a value (all `t()` results found
flow to display props); plurals are per-locale CLDR, not a two-form assumption.

---

## Part 3 - Deployment path, end to end

Judged against the current stack, not the script's comments.

**What the script gets right**: every secret the deploy compose marks `:?` is
generated by `cmd_install` (lines 968-1000), including the wave-3 least-privilege
DB roles, the scoped S3 credential, the KMS key, the Qdrant API key, the mail
intake token and `COGETO_MASTER_KEY`. Deploy assets are pinned to the commit a
tag resolves to and every file is checksum-verified before it is moved into place
(`fetch_one`, lines 682-708); `node scripts/ci/deploy-assets-manifest.mjs`
confirms the manifest matches all 5 assets today. The install checklist prints
both required A records (`add_install_checklist:852-853`) and adds the mail
A/MX/PTR/SPF items only when the mail capability is on, which matches the
compose reality. `features enable redaction/demo/consoles` correctly *refuse* on
a deploy stack because those services do not exist there. `cogeto reindex` uses
`compose run --rm`, so it works while the services crash-loop.

**What it gets wrong**: `ensure_wave3_secrets` (lines 339-346) omits
`COGETO_MASTER_KEY` (F1). `configure --mistral-key` and `features enable
local-models` write variables the seeded instance ignores (F2, F3). Its
`FEATURE_IDS` list predates `vision`, `reasoning` and `connectors`, which the
live registry reports (F15). Two of its own TODOs name the superseded
`docker compose exec worker npm run reindex` (lines 1493, 1548).

**Documentation an operator would follow**: the runbook is otherwise strong and
checklist-driven, but four instructions are wrong as written: the STARTTLS
procedure (F4), the Ollama `.env` configuration (F8), the model-key
troubleshooting row (F2), and the restore DNS count (F10).
`docs/operations/upgrade-notes.md` contradicts itself about the reindex command
and the embeddings model within one file (F9). `docs/deployment.md` omits
`features` and `reindex` from its command list (F16).

**Verdict**: a customer instance **can** be brought up, verified, backed up and
restored using only this repository. It **cannot** be upgraded from an earlier
release without an undocumented manual `.env` edit (F1), and inbound-mail
STARTTLS cannot be completed as documented (F4).

---

## Findings

### BLOCKER

**F1 - `cogeto upgrade` does not generate `COGETO_MASTER_KEY`; every existing
instance fails to boot after upgrading to v1.6.0.**
*Evidence*: `scripts/operator/cogeto:339-346` (`ensure_wave3_secrets` backfills
six variables, not this one) called at line 1088; `project/infra/deploy/
docker-compose.deploy.yml:185` passes `${COGETO_MASTER_KEY:-}` so compose does
not enforce it either; `project/src/providers/domain/seed.ts:76-81` throws
`MASTER_KEY_MISSING` when the environment holds a real provider key and no
master key; `project/src/entrypoints/model-boot.ts:31-38` calls that on every app
and worker boot with no catch. `git tag --contains` confirms migration 0052 first
shipped in **v1.6.0**, and `cmd_install:1000` writes `COGETO_MISTRAL_API_KEY`
into `.env` on every install, so the precondition holds for every real instance.
`docs/operations/upgrade-notes.md:68` states "`cogeto upgrade` generates one for
you if it is missing."
*Consequence*: upgrading any v1.0-v1.5 customer instance to v1.6.0 takes app and
worker into a crash loop; the instance is offline until an operator hand-edits
`.env`, and `configure --regenerate COGETO_MASTER_KEY` is refused as data-bound.
*Fix scope*: code - add `COGETO_MASTER_KEY` to `ensure_wave3_secrets` (guarded so
it is never regenerated when already set), and correct the upgrade note.

### HIGH

**F2 - `cogeto configure --mistral-key` is a no-op on any instance that has
booted once, and it is the documented recovery.**
*Evidence*: `seed.ts:51-53` returns `already_seeded` on the state row, after which
`load-configuration.ts:19-22` ignores the environment entirely;
`scripts/operator/cogeto:1655` writes the variable anyway and line 1628 reports it
as the instance's model key. `cmd_install:1001` prints
`todo_now "Set the model API key: cogeto configure --mistral-key …"` **after**
`compose up -d` at line 1015 has already claimed the seed with no key, and
`docs/operator-runbook.md:650` gives the same command as the fix for "Chat/
extraction fail with a model error".
*Consequence*: an operator who installs without `--mistral-key` follows the
printed checklist, sees the script report the key as `<set>`, and model features
stay off with no indication why. The only working path (Providers in the left
rail) is never mentioned by the script or the runbook.
*Fix scope*: code - make `configure --mistral-key` either refuse post-seed with a
pointer to the Providers page, or write through the providers API; update the
checklist and runbook row.

**F3 - `cogeto features enable local-models` changes nothing and warns about a
consequence that will not happen.**
*Evidence*: `scripts/operator/cogeto:1485-1493` sets `COGETO_PROVIDER_PRESET` and
`COGETO_OLLAMA_BASE_URL` in `.env` after a typed confirmation stating the
embeddings model will change; both are seed-only per `seed.ts` and
`docs/features/models.md:148-152`. Line 1493 then names the superseded
`docker compose exec worker npm run reindex`.
*Consequence*: the operator believes the instance moved to local models; it did
not. `features` also reports it as `enabled` (line 1316 keys off the same
variable), so the state display agrees with the wrong belief.
*Fix scope*: code - route the capability through the providers API, or refuse and
point at Models.

**F4 - The documented inbound-mail STARTTLS procedure cannot work.**
*Evidence*: `docs/operator-runbook.md:214-219` tells the operator to copy "the
Let's Encrypt certificate Caddy already obtained for the mail host" from
`caddy-data/.../certificates/.../mail.<domain>`. `project/infra/deploy/Caddyfile`
declares exactly two vhosts, `{$COGETO_EXTERNAL_DOMAIN}` and
`s3.{$COGETO_EXTERNAL_DOMAIN}`; there is no `mail.<domain>` site and no
on-demand TLS, so that certificate is never issued and the directory does not
exist. The same block's line 219 runs `docker compose -f docker-compose.deploy.yml
restart mail`, but `scripts/operator/cogeto:660` installs the file as
`$COGETO_ROOT/docker-compose.yml`.
*Consequence*: an operator enabling email capture cannot enable STARTTLS by
following the runbook; inbound mail stays cleartext on port 25 and the command
fails with "no such file".
*Fix scope*: code + docs - add a `mail.{$COGETO_EXTERNAL_DOMAIN}` vhost (or an
explicit ACME-only site block) to the deploy Caddyfile, and fix the compose
filename in the runbook.

**F5 - Redaction is presented as a deployment posture but does not exist in the
deploy channel.**
*Evidence*: `docs/security/data-sovereignty-and-redaction.md:28-38` describes it
as the answer "for deployments that must not send raw personal data to any
external API", with no availability caveat. `project/infra/deploy/
docker-compose.deploy.yml:15-18` says the redaction profile is absent, and the
file contains no `redaction` service and no `REDACTION_ENABLED` / `REDACTION_URL`
/ `REDACTION_REQUIRED` on app or worker (grep: 0 hits, versus 4/1/1 in the dev
compose). `.env.example:333-341` documents `REDACTION_*` without saying so either.
*Consequence*: a customer or security reviewer reading the security
documentation concludes the instance can be run fail-closed against PII egress.
On the supported deployment path it cannot, and even setting the variables by
hand would do nothing because the app never receives them.
*Fix scope*: docs (owner action) - state the deploy-channel limitation in the
security doc and `.env.example`; or code, to publish the sidecar image and add
the profile.

**F6 - The environment-consistency check has three structural blind spots and
both live configuration bugs sit inside them.**
*Evidence*: `env-consistency.spec.ts:13` (`SRC = process.cwd()`, i.e.
`project/src` only), `:40` (`COGETO_` prefix only, `env.NAME` syntax only). The
mail service's three variables, the redaction sidecar's, the operator script's,
the SPA's and `zitadel-init/init.mjs`'s are all outside the walk;
`provider-config.ts` reads via `read(env, 'NAME')` so its entire family is
unseen.
*Consequence*: the check reports "in sync" while F7 and F5 are true. It is
credited in CI as covering both directions and all services; it covers neither
fully.
*Fix scope*: code - widen the walk to the shipped services and scripts, match the
`read(env, '…')`/`readTimeoutMs(env, '…')` forms, and extend the prefix set.

**F7 - Documented live environment knobs are dropped by the deploy compose while
their legacy aliases are wired.**
*Evidence*: `.env.example:90-102` explicitly lists `COGETO_MODEL_TIMEOUT_*` and
`COGETO_REASONING_HEADROOM` as "what is still environment configuration";
`docs/operations/upgrade-notes.md:99` repeats it. `docker-compose.yml:224-227,241`
passes all five. `project/infra/deploy/docker-compose.deploy.yml` passes **none**
of them, but does pass `COGETO_OLLAMA_TIMEOUT_*` (lines 248-250), the legacy
alias `readTimeoutMs` still honours (`provider-config.ts:530`).
`.env.example` also documents `COGETO_REASONING_HEADROOM` twice, at lines 102
and 212.
*Consequence*: exactly the class that breaks a customer install and not a
developer install. An operator running a self-hosted endpoint raises the
documented timeout, restarts, and the value never reaches the process; local
inference keeps timing out at the default.
*Fix scope*: code - add the five variables to the deploy compose.

### MEDIUM

**F8 - The runbook's Ollama configuration steps edit `.env` variables the
instance ignores.**
*Evidence*: `docs/operator-runbook.md:340-347` instructs setting
`COGETO_PROVIDER_PRESET=ollama-local`, `COGETO_PROVIDER_EMBEDDINGS=ollama`,
`COGETO_MODEL_EMBEDDINGS=bge-m3` and `COGETO_OLLAMA_BASE_URL` in
`/srv/cogeto/.env`; `docs/features/models.md:148-152` states these are ignored
after the one-time seed. Line 348-355 of the runbook then correctly describes the
Models page, so the section contradicts itself.
*Consequence*: an operator following step 3 changes nothing and then cannot
explain why step 5's status output shows the old configuration.
*Fix scope*: docs.

**F9 - `upgrade-notes.md` contradicts itself about the reindex command and the
embeddings model.**
*Evidence*: lines 25-35 state `cogeto reindex` is first-class and that the
command changed from `docker compose exec worker npm run reindex` to
`docker compose run --rm worker npm run reindex`; lines 101-109 of the same file
state "The embeddings model still cannot be changed from the interface … interim
path: `docker compose exec worker npm run reindex`". The operator script repeats
the stale `exec` form at lines 1493 and 1548.
*Consequence*: an operator reading the file top to bottom gets the correct
answer, then the superseded one; `exec` fails in exactly the crash-loop case the
command exists for.
*Fix scope*: docs + one-line script edit.

**F10 - The restore procedure's DNS step names records that may not exist.**
*Evidence*: `docs/operator-runbook.md:471` says to update "the **four records**
from section 2a (three A records + the MX target's A record)". Section 2a
(lines 156-160) defines two always-present A records and two mail-only records,
and the mail records are omitted entirely on a mail-less instance.
*Consequence*: during a restore, the highest-stress operation in the runbook, the
operator looks for records that do not exist.
*Fix scope*: docs.

**F11 - No container-level privilege hardening in either compose.** **RESOLVED
(wave 5).**
*Evidence*: grep across both files: `cap_drop` 0, `security_opt` 0
(`no-new-privileges` 0), `read_only` 0, `user:` 0, `tmpfs` 0. Only `mem_limit`/
`cpus`/`pids_limit` are set (SEC-17). The application image sets `USER node`, but
postgres, minio, qdrant, zitadel, searxng, caddy and the init one-shots run with
their image defaults and full default capabilities.
*Consequence*: a container escape or a privileged-helper exploit has more surface
than it needs, on an internet-facing single-tenant box.
*Fix scope*: code - add `security_opt: [no-new-privileges:true]` and `cap_drop:
[ALL]` (plus targeted `cap_add`) per service in both composes.

**F12 - `SEARXNG_SECRET` can be empty on a deployed research profile and nothing
refuses it.** **RESOLVED (wave 5), in the preflight and in the healthcheck.**
*Evidence*: `project/infra/deploy/docker-compose.deploy.yml:715` and `:365` use
`${SEARXNG_SECRET:-}` (deliberately, so profile-down `compose up` works);
`secret-preflight.ts:86` skips any variable whose value is `''`. Only
`features enable research` generates one (`scripts/operator/cogeto:1407`).
*Consequence*: an operator who adds `research` to `COMPOSE_PROFILES` by hand runs
SearXNG with no session/image-proxy secret. Internal-network only, so the blast
radius is small, but it defeats the stated rule that no known-bad secret state
survives onto a reachable deployment.
*Fix scope*: code - have preflight (or the searxng service healthcheck) fail when
the profile is active and the secret is empty.

**F13 - User-visible server text is not translatable.** **RESOLVED (wave 6):
every user-facing failure carries a stable error code the interface
translates, and the guard now sees the server.**
*Evidence*: 197 Nest exception sites in `project/src` carry hardcoded English
messages (`grep -c` over `BadRequest|NotFound|Forbidden|Conflict Exception('…')`);
`serverT` appears at only 20 call sites across 4 namespaces / 223 keys; the SPA
renders a raw `error.message` at 35 sites (`Settings.tsx:1042,1470,1599,
1775,1854,1961,2030,2141,2295,2418`, `Reports.tsx:80,172,294`, `Chat.tsx:844,871,
946`, `SourceDrawer.tsx:241,248,262,949`, `MemoryDrawer.tsx:164`,
`ProjectPickerDrawer.tsx:58,74`, `GovernedMemories.tsx:202`).
*Consequence*: a Croatian, German or French user sees English error text in the
middle of a translated page, and no CI check can see it.
*Fix scope*: code - route user-facing API errors through the server catalogue, or
map error codes to SPA keys.

**F14 - hr/de/fr are described as scaffolds but are partially translated, which
is worse than either extreme.** **RESOLVED (wave 6): all three locales are
complete, and a value that reverts to its English source now fails the
build.**
*Evidence*: table in Part 2. 42-45% of SPA values are still literal English, but
six whole namespaces (sources, providers, connections, projects, reports,
extraction: 631 keys) are ~100% English while chat, memories and dashboard are
mostly translated. `CLAUDE.md` and `docs/cogeto-v2-plan.md:70` describe every
scaffold as "carrying the English text as its value".
*Consequence*: a Croatian user's Sources page is entirely English while their
Chat page is Croatian. Shipping this as a supported interface language is a
customer-visible quality claim the repository does not support.
*Fix scope*: owner action - either finish the six namespaces or gate the locale
picker to English until a locale crosses a stated threshold.

**F15 - `cogeto features` does not know about three capabilities the registry
reports.**
*Evidence*: `scripts/operator/cogeto:263` `FEATURE_IDS="redaction research mail
demo consoles local-models"`; the live `/api/health` on the running stack returns
`vision`, `reasoning` and `connectors` in addition (observed). The runbook's own
list (`docs/operator-runbook.md:368-369`) omits `mail`, which the script does have.
*Consequence*: the configured-state list an operator reads is silently
incomplete; two docs and the script disagree on the capability set.
*Fix scope*: code + docs.

**F16 - `docs/deployment.md` omits two subcommands.**
*Evidence*: `docs/deployment.md:27-29` lists "`install` / `configure` /
`upgrade` / `status` / `backup-info`, plus a `--check` dry run"; `main()` at
`scripts/operator/cogeto:1755` also dispatches `features` and `reindex`.
*Consequence*: the deployment overview understates the tooling; an operator may
not discover `reindex`, which is the documented repair for a restored backup.
*Fix scope*: docs.

### LOW

**F17 - A zero-byte file named `file` is committed and ships in the production
image.** **RESOLVED (wave 5): deleted, and the evaluation entrypoints went with
it.** `eval/trust-scores/file` (0 bytes, tracked; `git ls-files` confirms),
and `.dockerignore` allowlists `!eval/trust-scores`, so it is copied into the
runtime image by `project/infra/docker/Dockerfile:81`. Harmless, and exactly the
kind of artifact a customer or reviewer notices. *Fix scope*: owner action -
delete it.

**F18 - The SearXNG image digest carries no tag comment.**
`docker-compose.yml:973` and `docker-compose.deploy.yml:709` pin
`searxng/searxng@sha256:b8ca38…` with no `# searxng/searxng:<tag>` line, while
`docs/operations/image-pins.md:23-27` states "Recording the real tag matters: a
digest pinned against `# minio/minio:latest` is unauditable". The guard in
`deployment-hardening.spec.ts:78-91` only rejects `:latest` comments, not missing
ones, so this passes CI. *Fix scope*: code - add the comment and tighten the
spec.

**F19 - Two Zitadel bootstrap variables are read but documented nowhere.**
`project/infra/docker/zitadel-init/init.mjs:39-40` reads
`ZITADEL_BOOTSTRAP_MACHINE_USERNAME` and `ZITADEL_BOOTSTRAP_STATE_FILE`; neither
appears in `.env.example` or either compose, so both always take their defaults.
The runbook's domain-change procedure (line 143) depends on the state file's path
being `/machinekey/bootstrap-state.json`, which is only knowable from the source.
*Fix scope*: docs.

**F20 - Unprefixed `MISTRAL_*` fallbacks survive with no documentation.**
`provider-config.ts:316-318,410` still reads `MISTRAL_MODEL_PIPELINE`,
`MISTRAL_MODEL_ANSWER`, `MISTRAL_EMBED_MODEL` and `MISTRAL_API_KEY` as
pre-1.0 fallbacks. They are in no compose, no `.env.example` and no doc, and the
env-consistency check cannot see them. Dead weight at best; a surprising seed
source at worst. *Fix scope*: code - remove.

**F21 - A demo-only limit knob leaked into the customer compose.**
`COGETO_DEMO_DAILY_UPLOAD_MAX` is present in the deploy compose while its eight
sibling `COGETO_DEMO_*` limit variables are correctly absent (grep matrix, Part
1). The env-consistency spec explicitly excepts `COGETO_DEMO*` from the deploy
check, so nothing catches it. *Fix scope*: code - remove the line.

**F22 - Stale version language and a missing subcommand in the script header.**
`docs/operator-runbook.md:547` is titled "Upgrading past 2.0" and refers to
"instances created at 2.0 or later" (line 549); there is no 2.0 release line (tags run
v1.0.5 to v1.6.0, and "V2.0" is a plan version). The operator script's own header
comment (lines 9-15) lists six subcommands and omits `reindex`, which `usage()`
and `main()` both have. *Fix scope*: docs.

---

## Part 4 - Security posture of a fresh deployment (summary)

Confirmed good, with evidence:

- Every secret in the deploy compose is `${VAR:?}`: `POSTGRES_PASSWORD`,
  `COGETO_APP_DB_PASSWORD`, `COGETO_MIGRATE_DB_PASSWORD`,
  `ZITADEL_DB_ADMIN_PASSWORD`, `COGETO_S3_SECRET_KEY`, `MINIO_ROOT_*`,
  `MINIO_KMS_SECRET_KEY`, `ZITADEL_MASTERKEY`, `ZITADEL_DB_PASSWORD`,
  `ZITADEL_ADMIN_*`, `COGETO_QDRANT_API_KEY`, `COGETO_MAIL_INTAKE_TOKEN`.
- The `preflight` one-shot is the only process handed every secret and refuses
  every committed dev value on a non-localhost domain
  (`secret-preflight.ts:30-70`, `preflight.ts`), and `loadConfig` repeats the
  check per process.
- Published surface is minimal and intentional: `80`, `443`, `443/udp`, plus
  `25` only under the `mail` profile. The consoles edge is dev-only and bound to
  `127.0.0.1`. The `s3.<domain>` vhost answers only `GET|HEAD /cogeto/*` and 403s
  everything else; `/api/email/intake*` is 404'd at the edge.
- Least-privilege is wired in the **deploy** compose, not only in dev: migrations
  run as `cogeto_migrate`, the runtime as `cogeto_app`, the superuser only in
  `db-init`, and MinIO's scoped `cogeto-app` credential in app/worker.
- Profile-gated services are genuinely off: the deploy compose defines only
  `research` and `mail` profiles, and `COGETO_PRODUCTION=1` is hardcoded.
- No secret in logs, health or endpoint output: `/api/config` returns only
  `{issuer, clientId}`; `/api/health` carries no credential; the boot banner logs
  the configuration id and tier bindings only; `key-confinement.spec.ts` asserts
  the sealed column is selected in exactly one function.

Drift and asymmetry found: **F5** (redaction documented but absent from deploy),
**F7** (timeout/headroom knobs present in dev, absent in deploy), **F11**
(no privilege hardening in either), **F12** (empty SearXNG secret),
**F21** (demo knob in the customer compose).

---

## Part 5 - Operational reality (summary)

| Question | Answer |
|---|---|
| Honest capability reporting, including newer capabilities | **Yes.** Observed `/api/health` returns `redaction, research, mail, demo, consoles, local-models, reasoning, vision, connectors`, each with `probed` and a `detail`/`error`, plus job states with `overdueAfterHours`. The boot banner prints the same. Gap is the operator script's list (F15). |
| Backup/restore matches the data stores, rehearsed | **Yes.** `docs/operator-runbook.md:423-433` and `:438-491` names `pg-data`, `minio-data`, `instance-keys`, `zitadel-machinekey`, `qdrant-data` (correctly marked rebuildable), `caddy-data`, plus `/srv/cogeto/.env`, and mandates a per-customer rehearsal. Only defect is the DNS record count (F10). |
| Reindex reachable from UI and shell, including an unstartable instance | **Yes.** Models page for the managed switch; `cogeto reindex` and `docker compose run --rm worker npm run reindex` from the shell; the boot guard's message names both (`model-boot.ts:115-119`). Two stale `exec` references remain (F9). |
| Migrations safe fresh and on upgrade | **Yes.** 59 migrations applied in order by a one-shot `migrate` container as the schema owner; the running stack reports `59 applied, latest 0059_duplicate_uploads.sql`. Migration 0035 (task removal) is ordered behind the `erase-task-conclusions` guard the runbook documents; 0052/0053 are additive. |
| Image pinning, update mechanism, version comments current | **Mostly.** Every `image:` in both composes is digest-pinned and CI enforces it; the update procedure is documented. One digest carries no tag comment (F18). |
| Anything dev-only, demo-only or one-shot in the production image or as a recurring job | **No recurring job.** The demo reset crontab line is added only when `config.demoMode` is set (`worker.ts:243-276`), and the demo profile is absent from the deploy compose. The Dockerfile strips `seed-object`, `seed-orphan`, `demo-seed`, `demo-reset` (line 61). Still shipped: `project/demo` (32 KB corpus, imported by the worker's reset library), `eval.js`/`eval-chat.js`/`gateway-smoke.js`/`vector-smoke.js`, and the two documented one-shots `erase-task-conclusions.js` and `dedupe-file-sources.js`. The one-shots are documented operator tools; the demo corpus and eval entrypoints are dead weight. Plus F17. |

---

## Part 6 - Other observations, and what is genuinely well done

Checked and clean, worth recording so the report is calibrated:

- **Repo health is green.** All five required checks pass locally: `npm run lint`
  (ESLint + Prettier + dash guard over 110 markdown files + `i18n:check`) exit 0;
  `npm run boundaries` exit 0 ("no dependency violations found, 840 modules, 4355
  dependencies cruised"); `npm run build` exit 0; `npm run test` exit 0 with
  **1671 tests passing** (shared 15, server 1527 passed / 2 skipped over 187
  files including the Testcontainers integration suites, web 129).
  Worth stating plainly for calibration: **every required check is green and the
  upgrade path still takes an instance down** (F1). The invariant suites cover
  the application; nothing exercises `cogeto upgrade` against a pre-0052
  database, which is why F1, F2 and F3 all survived CI.
  **Closed in wave 5**: `scripts/ci/operator-smoke.sh` runs the operator script
  against a real stack in CI (a cheap subset on every pull request, the full
  install on merges to main and on demand), and asserts the two things that made
  the tooling misleading rather than merely incomplete: nothing it prints may
  reference a mechanism the system no longer has, and `status` may never report a
  configuration that does not exist.
- **Documentation links hold.** 1 broken relative link across every markdown file
  in the repo (`project/eval/vertical/cases/hr/hr-v004-.../notes.md`, one `../`
  too many). No stale references to tasks, reminders or an approval queue in any
  operator-facing document.
- **The deploy asset chain is genuinely verified**, not decorative: commit-pinned
  fetch, a checksum manifest fetched at the same commit, a missing manifest entry
  is a hard failure rather than a skip, and the manifest is current today.
- **The deploy compose is the hardened one.** Least-privilege DB roles, the
  scoped S3 credential, required-secret syntax, `COGETO_PRODUCTION=1`, and the
  strict CSP/HSTS headers on both the API and SPA handlers are all in the
  customer file, not only in dev. The usual asymmetry runs the other way here.
- **Secrets discipline is real and structural**: the dev-secret refusal list, the
  data-bound rotation refusal in `configure --regenerate`, the loud refusal to
  ever rotate the receipt-signing keypair, and `key-confinement.spec.ts`.
- **i18n plural handling is correct per locale** (Croatian one/few/other, French
  one/many/other), and every date, time, number and byte size goes through one
  locale-aware helper. Both are the kind of thing that is normally wrong.
- **Health output is honest**, including reporting the local stack as `degraded`
  with named causes rather than green-washing.
- **The install checklist is the strongest artifact in the deployment path**:
  instance-specific DNS records with real values, conditional on the mail
  capability, with the vault and backup items separated from the DNS-dependent
  ones.

---

## Proposed fix clustering

Ordered so blockers clear first. Sizes are relative effort, not calendar.

| # | Cluster | Findings | Size | Kind |
|---|---|---|---|---|
| 1 | **Unblock the upgrade path**: backfill `COGETO_MASTER_KEY` in `ensure_wave3_secrets`, correct `upgrade-notes.md:68`. | F1 | S | code |
| 2 | **Stop the operator tooling writing ignored model variables**: refuse or route `configure --mistral-key` and `features enable local-models` through the providers API; fix the install checklist TODO and the runbook troubleshooting row. | F2, F3 | M | code |
| 3 | ~~**Make the deploy compose deliver what is documented**~~ **DONE** (wave 2). | F7, F21, F6 | M | code |
| 4 | ~~**Fix the mail STARTTLS path**~~ **DONE** (wave 2), by building the producing half rather than documenting a copy. | F4 | M | code + docs |
| 5 | **Tell the truth about redaction and capabilities.** F5 is **DONE** (wave 2), and the owner's ruling was to remove the limitation rather than document it: redaction is published and available on a customer instance. F15/F16 remain. | F5, F15, F16 | S | docs (owner) |
| 6 | **Runbook and upgrade-note corrections**: Ollama section, the self-contradiction about reindex, the restore DNS count, the "past 2.0" section title, the script header, the Zitadel bootstrap variables. | F8, F9, F10, F19, F22 | S | docs |
| 7 | ~~**Container privilege hardening** in both composes, plus the empty-SearXNG-secret refusal.~~ **DONE** (wave 5), verified by running real work through the hardened stack. | F11, F12 | M | code |
| 8 | ~~**Server-side copy**: route user-facing API errors through the server catalogue and extend the i18n guard to cover them.~~ **DONE** (wave 6), by error codes rather than the catalogue; the rationale is recorded. | F13 | L | code |
| 9 | ~~**Finish or gate the translations** for the six English-only namespaces (631 keys x 3 locales).~~ **DONE** (wave 6): the owner ruled finish, not gate, and all three locales are complete and guarded. | F14 | L | owner |
| 10 | ~~**Housekeeping**: delete `eval/trust-scores/file`, add the SearXNG tag comment and tighten the pin spec, remove the unprefixed `MISTRAL_*` fallbacks, fix the one broken doc link.~~ **DONE** (F18 in wave 2, F20 in wave 1, F17 and the link guard in wave 5). | F17, F18, F20 | S | code + owner |
