# Deployment remediation verification

Scope: are the twenty-two findings of
[`deployment-readiness.md`](deployment-readiness.md) genuinely resolved, did the
five remediation units break or weaken anything, and did they introduce
problems of their own? Read-only verification against the working tree at
`f7b8afb` (v1.7.2 line), 2026-08-15. Evidence is file:line, command output, or
observed behaviour on a running stack. Nothing was changed; this report is the
only file written.

---

## Executive summary

**A customer instance can be installed, verified, operated, backed up and
restored today using only this repository.** The blocker and the two
documentation traps that made the original verdict conditional are gone, and
each of the three was checked against the code rather than against the report
that claims it.

Counts: **22 resolved, 0 partial, 0 incorrect, 0 accepted, 0 outstanding.**
Nothing is partial or incorrect. All five required checks are green locally
(`lint`, `boundaries`, `build` exit 0; `test` exit 0 with 1796 passing,
2 skipped, 190+26+2 files), the deploy asset manifest verifies all 5 assets,
and no regression was found in any of the six areas re-tested: model
configuration, the deploy channel, hardening, coverage, internationalisation
and documentation each hold the property claimed for them, several confirmed
live rather than by reading.

**Seven new issues**, none blocking: two medium interaction defects the
remediation created (`sync_mail_tls_site` silently reverts the documented
operator-supplied-certificate override; the capability-list invariant is
enforced only post-merge), one medium process gap (`operator-smoke-fast` runs
on pull requests but is **not** a required check, and the workflow doc still
says five), and four low. Details and fix scopes in **Part 3**.

**Status, 2026-08-15**: six of the seven are **RESOLVED** in the
`fix/verification-followup` change (issues #600 to #603): N1, N2, N3, N4, N5 and
N7. **N6 remains OPEN**, pending a visual pass over the German and French
interface in a browser, which nothing in `lint` or `test` can perform. Each
resolution is recorded under its finding below.

**Not examined**: cosign verification and Docker Hub resolution against
published artifacts, a real Ubuntu install, DNS and certificate issuance, real
mail delivery, and the model-dependent half of "real work" (document ingestion,
embedding rebuild, research capture, deletion receipt), because the observed
instance has no model provider and configuring one means an external call with
real data. Part 4 lists what only a real host can prove.

---

## Part 1: finding by finding

Verdict key: **resolved** (the property holds and something proves it),
partial, incorrect, accepted, outstanding.

| # | Sev | Verdict | Evidence |
|---|---|---|---|
| **F1** upgrade never generates `COGETO_MASTER_KEY` | BLOCKER | **resolved** | The precondition is unreachable: `providers/domain/` has no `seed.ts` and `MASTER_KEY_MISSING` occurs nowhere in the tree. Independently backfilled at `scripts/operator/cogeto:389`, guarded (`[ -n ... ] \|\| env_set`) so it is never rotated, called from `cmd_upgrade:1158`. Rotation still refused as data-bound (`:1804-1805`). `upgrade-notes.md` no longer claims the old behaviour (one mention, line 48, describing what the key is). `operator-smoke.sh:check_secret_backfill` asserts the function directly, including that an existing secret is untouched. |
| **F2** `configure --mistral-key` is a no-op and is the documented recovery | HIGH | **resolved** | `install --mistral-key` dies at `:971`, `configure --mistral-key` at `:1738`, both naming Providers. The runbook's troubleshooting row (`:697`) names Providers and "no restart needed". `status` reads the model state from the running app. Observed live: `/api/health` returns `models=off` with `detail: "no model provider configured; ... under Providers in the interface"`. |
| **F3** `features enable local-models` changes nothing | HIGH | **resolved** | `:1694-1695` refuses the id with the Providers pointer. The registry no longer has the entry: live `/api/health` returns exactly `models, redaction, research, mail, demo, consoles, reasoning, vision, connectors`. The `models` entry replaced it and reports honestly. |
| **F4** the documented inbound-mail STARTTLS procedure cannot work | HIGH | **resolved** | The producing half exists: an ACME-only vhost for `{$COGETO_MAIL_TLS_SITE:http://mail-tls-disabled.invalid}` in the deploy Caddyfile; `mail-tls-sync` (deploy compose `:1079`) running the edge image's `/usr/local/bin/cogeto-mail-tls-sync` (installed at `Dockerfile:116`) with `caddy-data:ro` and `mail-tls`; the mail entrypoint watches its own copy and exits so `restart: unless-stopped` reloads it. The mail container mounts `mail-tls:/app/tls:ro` and nothing else, so the boundary is intact. Observed live on the dev stack: an SMTP EHLO returns no `250-STARTTLS`, and the `mail` capability says so in words ("STARTTLS NOT advertised, forwarded mail arrives in CLEARTEXT"), which is the observability half the finding lacked. `openssl` is now in the mail image for the DH parameters. One authoritative description (`operations/email-inbound.md`); the other six files point at it. See **N2** for an interaction defect in the override path. |
| **F5** redaction is documented but absent from the deploy channel | HIGH | **resolved** | `release.yml` builds, pushes, cosign-signs (`:196`) and SBOM-attests (`:210-223`) `cogeto/cogeto-redaction`; `ci.yml`'s `docker-build` also builds it on every push, so it cannot rot unnoticed until a release. The deploy compose carries the service under `profiles: ['redaction']` (`:966-1003`) with no published port, and `REDACTION_ENABLED/_URL/_REQUIRED` sit on the `&cogeto-env` anchor (`:288-290`) merged into worker (`:360`) and migrate (`:456`), so both roots receive them. `features enable redaction` pulls and `verify_images` covers it because `env_set REDACTION_ENABLED` precedes `instance_images()`. Fail-closed is real: `redaction-client.ts:65-78` throws on a malformed reply, a rejection, and unreachability. |
| **F6** the env-consistency check has three blind spots | HIGH | **resolved** | `env-consistency.spec.ts` now walks six roots (`:42-49`) including the mail service, the Python sidecar, `zitadel-init` and `scripts/`, tracks eight prefixes (`:58-67`) and seven read forms (`:82-90`) including `read(env,'NAME')`, `os.environ`, and `${NAME}`. A guard-on-the-guard (`:249-261`) fails if any formerly invisible tree goes missing. The deploy-parity rule was replayed in memory against a mutated copy of the compose text: deleting `REDACTION_ENABLED`, `COGETO_MODEL_TIMEOUT_ANSWER_MS` or `COGETO_REASONING_HEADROOM` makes it fire. See **N4** for a latent tokenizer weakness. |
| **F7** documented knobs dropped by the deploy compose | HIGH | **resolved** | Deploy compose `:277-281` passes all four `COGETO_MODEL_TIMEOUT_*_MS` and `COGETO_REASONING_HEADROOM`. `COGETO_OLLAMA_TIMEOUT` occurs in neither compose nor any code path. Verified live inside the app container: the five are present (empty, so the defaults apply) and `COGETO_OLLAMA_TIMEOUT_PIPELINE_MS` is **ABSENT**. An empty value is safe: `read()` (`provider-config.ts:294-297`) maps empty to `undefined`, so `readTimeoutMs` returns the default rather than `NaN`; a garbage value throws loudly at boot. `.env.example` documents the headroom once (`:134`). |
| **F8** the runbook's Ollama steps edit ignored variables | MEDIUM | **resolved** | Runbook §4b is interface-first throughout: Providers, then Models, with the managed rebuild for embeddings. No `.env` model edit survives. Its container-networking verification command was run verbatim in shape against the running stack and works (`docker compose exec -T app node -e "fetch(...).then(r=>r.text()).then(console.log)"` returned `OK`). |
| **F9** `upgrade-notes.md` contradicts itself about reindex | MEDIUM | **resolved** | `docker compose exec worker npm run reindex` appears nowhere in `docs/` or `scripts/` except inside this audit's own quotations and the smoke test's retired-mechanism list. Every live mention is the `run --rm` form (`operator-runbook.md:386,527`, `features/models.md:252`). |
| **F10** the restore DNS step names records that may not exist | MEDIUM | **resolved** | `operator-runbook.md:533-536` states which records always exist, which exist only with email capture on, and that the MX record names a hostname so it does not change. No count. |
| **F11** no container privilege hardening | MEDIUM | **resolved** | Parsed both files: **21 of 21** services in the dev compose and **18 of 18** in the deploy compose carry `cap_drop: [ALL]` and `no-new-privileges:true`; 12 dev and 13 deploy services also run `read_only: true` with an explicit tmpfs. Grants are symmetric between the files and pinned exactly by `deployment-hardening.spec.ts:361-397`; the internet-facing mail service grants none, asserted separately. Two exceptions carry measured reasons in the file (Qdrant panics; mail writes its config dir). Confirmed on the running containers: `docker inspect` reports `CapDrop=[ALL]` on all nine, `ReadonlyRootfs=true` on app, worker, minio and zitadel, and the exact expected `CapAdd` lists. |
| **F12** an empty `SEARXNG_SECRET` on an active research profile | MEDIUM | **resolved** | `secret-preflight.ts:94-139`: `PROFILE_REQUIRED_SECRETS`, `findEmptyProfileSecrets` reading the mirrored `COGETO_COMPOSE_PROFILES` (wired in both composes) or the capability flag, and `assertProfileSecrets` throwing with the variable named. The SearXNG healthcheck carries the same refusal as a `CMD-SHELL` guard, covering a bare `compose up searxng`. It applies on localhost by design, stated in the doc comment. |
| **F13** user-visible server text is not translatable | MEDIUM | **resolved** | 191 `userError.*` and 50 `untranslatedError.*` call sites. Exactly **one** direct Nest exception survives outside `api-error.ts` (`email/email-intake.controller.ts:63`), carrying an `i18n-exempt:` comment whose reason is correct: the body is a machine verdict for Haraka. The scan is exact, not heuristic (`check-i18n.mjs:434-451`, inside `lint`). The SPA renders no raw server text at the named sites (Settings, Reports, Chat, SourceDrawer, MemoryDrawer, ProjectPickerDrawer, GovernedMemories all route through `apiErrorMessage`; the remaining `.message` hits are `messageId` identifiers). The degradation ladder in `i18n/api-error.ts:38-51` never shows a bare code or an empty string, and `i18next.exists` is called with the params so a plural key resolves. In the actual build, English `serverErrors` is bundled eagerly into the main chunk (the guaranteed fallback) and `de`, `fr`, `hr` are three separate lazy chunks. |
| **F14** hr/de/fr are partial translations | MEDIUM | **resolved** | `npm run i18n:check`: "3 locales in sync and fully translated (de 1944/1944, fr 2026/2026, hr 2026/2026 values translated, 115 identical by design)". Every one of the 115 allowlist entries was read: they are product names, format tokens and genuine cognates, and an entry that excuses nothing fails the build (`check-i18n.mjs:506-530`). Plural categories are correct per locale: 78 plural keys, 2 forms in `en`/`de`, 3 in `hr` (`_few`) and `fr` (`_many`). Spot-checked `navigation.json`: real translations in all three, and the identical values ("Audit", "Contradictions" in French) are genuinely identical. |
| **F15** `cogeto features` does not know three capabilities | MEDIUM | **resolved** | `FEATURE_IDS` (5) plus `FEATURE_IDS_REPORTED_ONLY` (4) equals exactly the nine ids live `/api/health` returns; `local-models` is in neither. Asking to enable one of the four dies naming where it is decided (`:1700`). `operations/operator-script.md:17` and the runbook carry the same two groups. See **N3**: the union invariant is enforced only post-merge. |
| **F16** `docs/deployment.md` omits two subcommands | MEDIUM | **resolved** | `deployment.md:35-43` lists all seven plus the three global flags, matching the script header (`:9-15`) and `usage()`. |
| **F17** a zero-byte `file` ships in the production image | LOW | **resolved** | `git ls-files` no longer tracks `eval/trust-scores/file`. |
| **F18** the SearXNG digest carries no tag comment | LOW | **resolved, and tightened** | `deployment-hardening.spec.ts:92-151` now **discovers** every Dockerfile rather than reading a list, asserts at least 5 pin files, rejects a `:latest` comment **and** a missing one, and fails if a file declares no pins at all. The SearXNG digest carries `# searxng/searxng:2026.7.19-6da6eee26`. |
| **F19** two Zitadel bootstrap variables documented nowhere | LOW | **resolved** | `.env.example:217-222` documents both with their defaults and, more usefully, what the defaults mean; both are wired in both composes. |
| **F20** unprefixed `MISTRAL_*` fallbacks | LOW | **resolved** | The unprefixed names appear only in `model-config-env.spec.ts` (the structural guard, which asserts both inertness and confinement) and one live-skip in a gateway seam spec. No shipped code path reads them. |
| **F21** a demo knob in the customer compose | LOW | **resolved** | No `COGETO_DEMO` string in the deploy compose at all. The blanket prefix exception is explicitly paired with an outright-absence assertion (`env-consistency.spec.ts:225-237`), which is the right shape given the exception is what hid it. |
| **F22** stale version language and a missing subcommand | LOW | **resolved** | "Upgrading past 2.0" occurs nowhere outside this audit's quotations. Three subcommand lists (script header, `usage()`, `deployment.md`) agree on all seven. |

---

## Part 2: regression hunt in the areas the fixes touched

### Model configuration

| Property | Holds | How verified |
|---|---|---|
| No path resolves a provider or model from the environment | yes | `model-boot.ts` states and implements "no fall back to the environment"; neither compose passes any legacy model variable (grep for the `COGETO_MISTRAL_*`, `COGETO_OPENAI_*`, `COGETO_ANTHROPIC_*`, `COGETO_OLLAMA_*`, `COGETO_MODEL_*` and `COGETO_PROVIDER_*` families returns nothing outside comments); `model-config-env.spec.ts` forbids reappearance. |
| A stale variable in an environment file has no effect | yes, **observed** | The dev `.env` still holds `COGETO_MISTRAL_API_KEY`. Inside the running app container that variable is **ABSENT** from `process.env`, and health reports `models=off`. This is the finding's exact failure mode, now structurally impossible. |
| A provider-less instance boots, serves, and explains itself | yes, **observed** | The observed instance has 0 providers and 0 memories, 59/59 migrations applied. `/api/health` is `ok`; the boot log carries `configuration: "unconfigured"` with the sentence "This is the normal first-run state, not an error"; the `models`, `reasoning` and `vision` entries each name the reason and where to fix it. |
| Configuring a provider takes effect without a restart | mechanism verified, not exercised | One `LiveModelConfiguration` mutated in place (`model-boot.ts`), `ProviderConfigService` polls a version column with `pollIntervalMs` threaded from both roots and a spec named `provider_config_version_watch`. Not exercised: adding a real provider means an external call with real data. |
| Nothing in the operator script or its output references model keys | yes | All eight retired mechanisms grepped against the whole script. The only hits are the two refusal messages that exist to reject them. |

### The deploy channel

Redaction: publishable and published (release plus the CI `docker-build` job), present behind its profile, on the shared anchor so both roots receive it, fail-closed in code at three distinct failure modes. The mail certificate is obtained by a dedicated ACME-only vhost, propagated by a sidecar that compares a fingerprint every 300 s so **renewal is the same code path as first issue**, and consumed by an entrypoint that restarts itself on change; the mail container mounts only `mail-tls:ro` and never `caddy-data`. The four timeout knobs and the headroom reach the process (observed); the retired alias does not (observed). The widened consistency check fires on a deliberately removed variable (replayed in memory).

Two propagation failure modes were tested rather than reasoned about, and both are clean:

- **Interrupted copy leaves an orphan `.tmp` owned by uid 1000.** Reproduced in the edge image under `--cap-drop ALL --cap-add CHOWN`: a direct write redirect to such a file correctly fails (`CapEff` is `0x1`, so root genuinely has no `DAC_OVERRIDE`), but busybox `cp` unlinks and recreates, so the loop recovers and the file returns root-owned before the `chmod`/`chown`. No crash loop.
- **Kill between the two `mv`s** can leave `cert.pem` new and `key.pem` old for up to one sync interval. Self-healing: the marker is written only after both renames, so the next cycle reinstalls both. Worth knowing, not worth fixing.

### Hardening

Both compose files are complete and symmetric (21/21 and 18/18), the grants are pinned by spec, and the two exceptions carry measured reasons. Live containers confirm the posture rather than the file claiming it.

Real work through the hardened stack, **reproduced independently by this verification**:

- **Inbound mail**, end to end: a message through the internet-facing Haraka container (`cap_drop: ALL`) to the app's intake (read-only root) produced the correct SMTP `550 sender not accepted` and an `email_refusal` row with reason `sender_not_recognized`.
- **Redaction**, real NER work: the sidecar image run standalone with `--read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp` loaded `en_core_web_lg`, reported healthy, and pseudonymized a name, an email address and a phone number correctly. This was the service most at risk from a read-only root (a Python process whose `HOME` is on the image root) and it is clean.
- **The app and worker** have been serving for hours on read-only roots with 64 MB and 256 MB `/tmp` tmpfs. The temp-file risk is structurally absent: uploads use `multer.memoryStorage()`, and both `tesseract` and `pdftoppm` are driven through stdin and stdout by `run-binary.ts`, so the OCR and rasterize path writes no temp files at all. The only `/tmp` writer in the server is the worker heartbeat.

Not reproduced here, and attested only by the wave-5 record in
`security/instance-and-supply-chain-hardening.md:176-188`: document ingestion to
verified facts, the forced OCR tier, a managed embedding rebuild, a research
capture, and a deletion with its receipt. All five need a model provider, which
the observed instance does not have.

### Coverage

`scripts/ci/operator-smoke.sh` exists (468 lines), runs `--fast` on every pull
request and `--full` on merges to main, and would catch the class it was
written for. Reasoning about what it asserts, not that it passes:

- **F1's class** is asserted against `ensure_wave3_secrets` itself: a missing master key must be backfilled to at least 20 characters, and `APP_DB=already-set-do-not-touch` must survive. That fails if the backfill is removed **or** if it starts rotating.
- **F2's class** is the strongest part: `status` must print `NOT CONFIGURED` and must **not** print `model provider = `, so reading a configuration back out of the file it just wrote fails the test. It also stops the worker and asserts `status` no longer calls it healthy, which is the difference between reporting and observing.
- **F15's class** compares the script's two id lists against the ids the running app's `/api/health` actually returns, and diffs them on mismatch.
- **F12's class** blanks the secret with the profile active and requires the preflight to exit non-zero naming `SEARXNG_SECRET`.
- The **retired-mechanism scan** is a real net: eight literal mechanisms, checked against captured output rather than source.
- It states its own limits honestly at the top, and the stub list is confined to network and supply-chain calls; secret generation, `.env` handling, compose, health reads and every subcommand's logic run for real.

Two qualifications, both raised as new issues: it is **not a required check**
(**N1**), and the retired-mechanism scan covers four subcommands' output, not
"everything the script prints" (**N7**).

### Internationalisation

Locales are complete and the completeness is guarded, not asserted. Server
errors surface as codes the interface translates, with a correct degradation
ladder and English bundled eagerly as the fallback. Plural categories are
correct per language. Every guard category is proved by breaking it:
`i18n-guard.spec.ts` copies the repository, introduces one deliberate
regression per category, and asserts the real script fails naming the offence,
across nine categories: missing key, dropped placeholder, missing plural
category, untranslated value, dead identical entry, server error without a code,
server error English drift, orphaned server error key, hardcoded JSX literal,
plus a clean-tree control. That is the right construction, and it runs inside
the required `test` job.

Checked and clean: no SPA site branches on server error text, and no `t()`
result is sent to an API or compared as a value.

### Documentation

Every command in the operator-facing documents was extracted and read; the
runnable shapes were exercised where a running stack allowed it. `lint` includes
a dash guard and a link guard over the markdown tree and exits 0. One truth per
subject holds for the two subjects the remediation touched: inbound-mail TLS is
described once in `operations/email-inbound.md` with six pointers to it, and
redaction availability is stated once in
`security/data-sovereignty-and-redaction.md`. `.env.example` is genuinely an
operator's reference: a four-tag ownership legend (`[operator]`, `[installer]`,
`[knob]`, `[dev]`), a required/optional mark per entry, and an explicit
"what is not in this file" section covering model configuration, connector
credentials, compose-fixed addresses and CI tooling. Every one of the 19
variables the deploy compose marks `${VAR:?}` is written by `cmd_install`.

---

## Part 3: what the fixes may have introduced

### N1 (MEDIUM): the operator smoke test is not a required check

*Evidence*: `.github/workflows/ci.yml:442` runs `operator-smoke-fast` on every
pull request, but the repository ruleset's required contexts are exactly
`lint, boundaries, test, build, eval-gate` (`gh api repos/:owner/:repo/rulesets/18893470`).
`docs/engineering-workflow.md:68-80` still says "These five checks must be green
before a PR can merge (branch protection on `main`)" and names only
`docker-build` as a non-required sixth job; neither `operator-smoke-fast` nor
`scan` appears at all.
*Consequence*: the coverage gap wave 5 closed can go red without blocking a
merge, which is the same shape as the gap itself (the invariant suites were
green while `cogeto upgrade` took an instance down). A reader of the workflow doc
also cannot discover that the operator script is now exercised in CI.
*Fix scope*: add `operator-smoke-fast` to the ruleset's required contexts and
add both new jobs to the table in `engineering-workflow.md`.

**RESOLVED (issue #601).** `operator-smoke-fast` is prepared as a required
context and named as one in the `ci.yml` header, beside the job itself; adding
it to the ruleset is the owner action the pull request prints, because a code
change cannot enforce a console setting. The other three jobs are now
DELIBERATELY advisory with the reason written down rather than inferred from an
absence: `scan` tracks upstream disclosures rather than the diff (it went red
with no commit in between on 2026-08-03, which is in its own allowlist), and
`operator-smoke-full` cannot be required at all, because it never runs on a
pull request and a required context that never reports blocks every merge. The
five-check table in `docs/engineering-workflow.md` is replaced by one listing
every job, whether it blocks and what it covers, and `CLAUDE.md`'s delivery loop
moved with it.

### N2 (MEDIUM): `sync_mail_tls_site` silently reverts the documented operator-supplied-certificate override

*Evidence*: `docs/operations/email-inbound.md:236-238` instructs an operator
using their own CA to "leave `COGETO_MAIL_TLS_SITE` empty (so the edge orders
nothing and `mail-tls-sync` idles rather than overwriting your files)", and
`.env.example:265-275` repeats that this is the supported override.
`scripts/operator/cogeto:836-843` unconditionally sets
`COGETO_MAIL_TLS_SITE` to `derive_mx_host "$domain"` whenever the mail
capability is enabled, and it is called from `cmd_upgrade:1165`,
`features enable/disable mail` (`:1552`, `:1636`) and the domain change
(`:1769`).
*Consequence*: an operator who followed the documented override has it reverted
by the next `cogeto upgrade`, with nothing said. If `mail.<domain>` then
resolves to the host, the edge orders an ACME certificate and `mail-tls-sync`
overwrites `cert.pem` and `key.pem` in the volume, moving the instance off the
operator's own CA. If it does not resolve, the files survive but the recorded
intent in `.env` is gone, so the next operator cannot tell the override was
deliberate. This is exactly the "over-corrected and now blocks legitimate use"
class: the convergence that makes F4 automatic overrides the one configuration
F4's own documentation tells an operator to make.
*Fix scope*: one function. Make the convergence skip a value the operator
deliberately blanked (for example a recorded `COGETO_MAIL_TLS_MODE=operator`
that `sync_mail_tls_site` honours), and have the override procedure set it.

**RESOLVED (issue #600).** The intention is RECORDED rather than inferred from
an empty value: `COGETO_MAIL_TLS_MODE`, `automatic` by default,
`operator` for an operator-supplied certificate. `sync_mail_tls_site` is the
single chokepoint and returns early in operator mode, saying so, so all four
call sites (`cmd_upgrade`, `features enable mail`, `features disable mail`,
`configure --domain`) leave the configuration alone; a test enumerates the call
sites and asserts the site variable has no writer outside the chokepoint and the
deliberate override. The procedure that sets it is
`cogeto configure --mail-tls-mode operator`, which also blanks the site, warns
that renewal is now the operator's, and adds the ownership step to the
checklist; going back asks for a typed confirmation naming what it overwrites.
`configure` with no arguments and `cogeto status` both report which mode is in
force. The sidecar honours the mode itself (`mail-tls-sync.sh`, wired through
the deploy compose), so the operator's material is not overwritten even if a
site value reappears: proved by running the loop against a populated volume.
`docs/operations/email-inbound.md` and `.env.example` carry the complete
procedure, including why blanking the site alone was never enough.

### N3 (MEDIUM): the capability-list invariant is enforced only post-merge

*Evidence*: `docs/operations/operator-script.md:17` states the rule that
`FEATURE_IDS_REPORTED_ONLY` "must stay equal to `CapabilityId` minus
`FEATURE_IDS`". The only check of that union is
`operator-smoke.sh:check_features_match_health`, which needs a running stack and
therefore runs in `operator-smoke-full`, on merges to main only, and is not
required (N1). Inside the required checks, `deployment-hardening.spec.ts:319`
pins the `FEATURE_IDS` string literal and nothing relates either list to
`CapabilityId` (grep for `FEATURE_IDS` across `project/src/**/*.spec.ts`
returns that one line).
*Consequence*: adding a tenth entry to `CapabilityId` reproduces F15 exactly, in
a pull request where every required check is green. F15 was a list that fell
behind the registry; the fix restored the list without adding the guard that
keeps it there.
*Fix scope*: a unit assertion that reads both bash arrays out of the script and
compares their union to the `CapabilityId` union type's members. The script is
already parsed by `operator-script.spec.ts`, so the machinery exists.

**RESOLVED (issue #602).** `operator-script.spec.ts` parses both lists out of
the script and compares their union to the `CapabilityId` members in
`project/shared/src/health.ts`, failing in EITHER direction (a capability the
script does not know, and a list entry the registry no longer reports), plus the
two lists being disjoint and every reported-only id having a
`feature_decided_by` answer. Verified by adding a tenth capability to the
registry without touching the script: `test` fails naming it. That runs inside
the required checks, so F15's class can no longer reach main through a green
pull request.

### N4 (LOW): the widened consistency check counts variables named in comments

*Evidence*: `env-consistency.spec.ts:158-167` (`varsIn`) tokenizes the whole
compose file with `/\b([A-Z][A-Z0-9_]*)\b/g`, comments included, and the
deploy-parity rule at `:290` asks only whether the name is in that set.
*Consequence*: a variable deleted from an `environment:` block but still named
in a nearby explanatory comment satisfies the parity rule while never reaching
the process, which is F7's failure mode surviving the check written for it. The
compose files carry many such comments, including ones that name the very
variables the remediation moved. Latent today: comparing the token sets with and
without comment lines shows **no** real variable is comment-only in either file
(only the fragments `COGETO_` and `COGETO_OLLAMA_TIMEOUT_`).
*Fix scope*: strip comment lines in `varsIn` before tokenizing, then re-run to
confirm nothing was relying on a comment.

**RESOLVED (issue #603).** `varsIn` strips comment lines for the two compose
files (and only for them: in `.env.example` a `#` line IS the entry, so
stripping there would erase the documentation). Re-running found the two things
the latent-today note predicted and one it did not: no real wired variable was
comment-only, but `.env.example` NAMES two variables in prose that are
deliberately not settings, `MINIO_SERVER_URL` ("do NOT set it") and the retired
`COGETO_OLLAMA_TIMEOUT_*_MS` alias, and both had been satisfying the
no-dead-entries rule by matching a compose comment. A sentence about a variable
is not an entry, so that rule now reads entry lines (`NAME=`, commented out or
not) rather than every token, which keeps the warnings and keeps the rule.

### N5 (LOW): the operator script's own header still lists three release images

*Evidence*: `scripts/operator/cogeto:27` says the instance pulls
"cogeto/cogeto, cogeto/cogeto-edge, cogeto/cogeto-mail". The redaction sidecar
is the fourth published, signed image and this script pulls and cosign-verifies
it (`:1584-1586`, via `instance_images():563-567`).
`operator-script.spec.ts:179` is likewise named "prints the cosign verify
commands for all three published images" (behaviourally correct on a dry run,
where redaction is off, but the name now misleads). Every operator-facing
document is already correct (`deployment.md:18-22`, `release-process.md:27,45`,
`operations/operator-script.md:29-33`).
*Consequence*: documentation only, inside the file an engineer reads first.
*Fix scope*: one comment line and one test name.

**RESOLVED (issue #603).** The header names all four images and says which one
is conditional and that this script pulls and verifies it via
`instance_images`. The test is renamed to what it asserts, and gained the
other half of the claim: on a dry run, where redaction is off, the redaction
verify command must be ABSENT.

### N6 (LOW): translated strings that may not fit their control

*Evidence*: 60 English strings of 28 characters or fewer expand to at least
twice their length in at least one locale. The tightest cases are in constrained
controls: `reports.status.pending` and `chat.attachment.stage.queued`
"Queued" become "In der Warteschlange" (20 chars in a status chip),
`connections.list.sync` "Sync now" becomes "Synchroniser maintenant",
`navigation.liveSandbox` "Live sandbox" becomes "Environnement de
démonstration actif", and `system.deadLetter.heading` "Dead-letter queue"
becomes a 49-character German compound.
*Consequence*: possible truncation or wrapping in badges, buttons and the nav
rail in `de` and `fr`. Nothing in `lint` or `test` can see layout, and the
completeness guard that made the locales real is precisely what introduced these
lengths.
*Fix scope*: a visual pass over the six worst surfaces in `de` and `fr`; where
a control cannot grow, a shorter locale-specific value rather than a wider box.
Unverifiable without a browser walk (Part 4).

**OPEN.** Deliberately not addressed by the follow-up change: it is the one
finding here that cannot be judged without looking at the rendered interface,
and guessing at shorter strings without seeing the controls would be a change
with no evidence behind it. It stays open pending that browser pass.

### N7 (LOW): the retired-mechanism scan covers less than it is described as covering

*Evidence*: the wave-5 status text describes "a no-retired-mechanism scan over
everything the script prints". `assert_no_retired_mechanism` is called against
four logs: the dry-run install, the real install, `status` and `features`. The
output of `upgrade`, `configure`, `backup-info` and `reindex` is never scanned,
and `upgrade` is not invoked at all (correctly listed under what the harness
cannot cover). Two of the original stale references (F9) lived in the upgrade
path.
*Consequence*: claim-versus-coverage mismatch rather than a live defect. All
eight mechanisms were grepped against the whole script here and the only hits
are the two intentional refusal messages, so nothing is currently hiding in the
unscanned output.
*Fix scope*: scan every captured log in `$LOGS` in one loop, and soften the
wave-5 sentence to what it does.

**RESOLVED (issue #601).** `check_retired_mechanisms_in_every_log` runs last and
scans every `*.txt` the run captured, labelled by log name, so a subcommand
added to the harness is covered the day it is added; the four hand-placed calls
are gone. The wave-5 sentence in `deployment-readiness.md` now says "over every
log the run captured" instead of "over everything the script prints", and the
harness states in the same place that it still cannot cover output from
subcommands it does not invoke.

### Checked and clean

Recorded so the report is calibrated, since each was a specific thing to
suspect:

- **The deploy asset manifest verifies.** `node scripts/ci/deploy-assets-manifest.mjs` reports it matches all 5 assets.
- **No unintended compose asymmetry.** Service-by-service, the two files differ only where they should: `caddy-consoles`, `seed-object`, `seed-orphan` and `demo-seed` are dev-only; `mail-tls-sync` is deploy-only because dev has no ACME. Capability grants, read-only roots and tmpfs sizes match service for service.
- **No new required variable or secret is ungenerated or unexplained.** All 19 `${VAR:?}` variables in the deploy compose are written by `cmd_install`; `COGETO_MASTER_KEY` is deliberately not required by compose and is generated on install and backfilled on upgrade; `COGETO_MAIL_TLS_SITE` is set by `features enable mail` and documented.
- **The redaction publishing step cannot fail silently.** It is built in the required-adjacent `docker-build` job on every push, signed and attested alongside the other three in `release.yml`, and named in the release notes footer's generated `cosign verify` block.
- **An empty timeout value does not become `NaN`.** `read()` maps empty and whitespace to `undefined`.
- **The read-only roots do not fail under load.** No server code path writes a temp file; OCR and rasterization stream through stdin and stdout.
- **The certificate propagation loop survives an interrupted copy** (tested in the edge image under the real capability set).
- **The edge image has every binary the sync loop uses** (`sha256sum`, `cp`, `chown`, `chmod`, `sleep`, `cat`, `printf`), and the mail image has the `openssl` the DH parameters need.
- **No translated string leaks into a stable-value position**, and no SPA site branches on server error text; 401 drives a session refresh rather than rendering its English sentence, which is why declaring it untranslatable is right.

---

## Part 4: deploy-today verdict

**Yes. A customer instance can be installed, verified, operated, backed up and
restored today using only this repository.** Nothing found here stands in the
way.

Specifically: the install path generates every secret the compose file requires
and prints an instance-specific checklist; the upgrade path backfills the key
whose absence was the original blocker and cannot crash-loop on it, because the
code that threw no longer exists; the model configuration an operator needs is
reachable only where the documentation now sends them, and an instance without
it is a normal, self-explaining state; inbound mail can be enabled and gets its
certificate without a human; redaction is a real, published, signed, fail-closed
option on the supported path; every container runs without capabilities; and the
backup and restore procedure names the right volumes with a DNS step that
matches the records that exist.

Two things an operator should be told before they rely on them: if they use
their own certificate authority for inbound mail, the next upgrade will revert
that choice (**N2**) until it is fixed, and a pull request that breaks the
operator script will not be blocked from merging (**N1**). Both were fixed in
the follow-up change: the override is now a recorded mode every convergence path
honours, and `operator-smoke-fast` is prepared as a required check (the ruleset
edit itself is an owner action in the settings console).

### What remains unverifiable without a real host

The manual install that follows is the only thing that can prove these:

1. **DNS and certificate issuance.** That Caddy obtains certificates for the app domain, `s3.<domain>` and `mail.<domain>` once the A records resolve, and that the mail vhost's ACME-only site orders exactly one certificate and serves 404.
2. **The full mail-TLS chain in production.** That `mail-tls-sync` finds the certificate under the real issuer directory, installs it with uid 1000 ownership, that Haraka then advertises `250-STARTTLS`, and above all that a **renewal 60 days later** propagates with no human action. Everything up to issuance is verified; issuance and renewal are not.
3. **The supply chain.** `cosign verify` against published signatures, Docker Hub tag resolution, and the commit-pinned asset fetch with checksum verification. The smoke harness replaces all of it and says so.
4. **A real upgrade between two published releases**, including the asset re-fetch and the image pull.
5. **Real mail delivery** from an outside sender over port 25 with SPF, and the PTR record.
6. **Backup and restore against the hosting panel**: OVHcloud automated backups, a real volume restore, and the reindex that follows it.
7. **The model-dependent half of "real work"**: ingesting a document to verified facts, a managed embedding rebuild, a research capture, and a deletion with its signed receipt. Attested by the wave-5 record but not re-verified here, because the observed instance has no provider.
8. **Interface layout in `de` and `fr`** (N6), and the interface half of the translated-error path: that a Croatian user actually sees Croatian error copy in the running SPA.
9. **A container escape or privileged-helper attempt** against the dropped capabilities. The posture is verified; its effect against a real attack is not.

---

## What is genuinely well done

Short and honest, because the calibration matters:

- **The fixes chose mechanism over documentation, twice.** F4 was closed by building the producing half rather than by documenting that the copy must be manual, and F5 by publishing the image rather than by adding an availability caveat. Both were offered the cheaper option in the audit and both refused it.
- **The hardening was verified by running work through it, not by watching it start**, and the two places where that failed are recorded in the compose file with what was measured. The `mail-tls-sync` script's own comments document two bugs found only by real capability drops, including the chmod-before-chown ordering, which is the kind of detail that is normally lost.
- **The i18n guard is proved by breaking it.** Nine deliberate regressions, one per category, each asserted to fail naming the offence. That is the difference between a check and a claim.
- **The server error design chose codes over a catalogue for a stated reason** and left exactly one exemption, in the one place where there is no person to read the sentence.
- **The smoke test's honesty about its own limits** is the strongest part of it: the "what it does not cover" block is longer than several of its assertions, and the two things it does assert are the two that made the tooling lie rather than merely lag.
- **`.env.example` answers the question an operator actually has** (which of these is mine?) with a four-way ownership tag and an explicit list of what is deliberately absent.
- **The image-pin guard now discovers its inputs.** The finding was an image nobody remembered to add to a list, and the fix removed the list.
