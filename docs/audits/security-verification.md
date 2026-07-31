# Verification of the security remediation programme

Date: 2026-07-30 · Commit verified: `f36e45b` (main, clean tree) · Version: 1.3.0
Baseline audited commit: `c37dd61` · Audit under verification:
[`security-audit-2.0.md`](security-audit-2.0.md)

Method: read-only. Static reading of the three remediation diffs against current
main; `npm run lint`, `npm run boundaries`, the full `npm test` suite (Vitest plus
Testcontainers); live probing of the running dev stack; and a complete boot of a
throwaway stack from empty volumes in an isolated compose project
(`-p cogeto-verify`), exercised end to end and then destroyed with its own volumes.
The owner's dev stack was stopped and restarted around that run, never deleted; its
data is intact. No file was modified except this report.

## A correction to the premise: there are three waves, not four

The verification request describes four merged waves. Only three exist on `main`:

| Wave | Commit | PR | Scope |
|---|---|---|---|
| 1 | `bd84868` | #292 | Health and integrity guards, HSTS, robots SSRF, CI scanning, hygiene batch |
| 2 | `990186d` | #309 | Prompt fencing, passport exports under the deletion saga |
| 3 | `e608d44` | #314 | Least-privilege Postgres roles, scoped MinIO credential, PAT revocation |

`git branch -a` shows `fix/security-wave1`, `wave2`, `wave3` and no fourth. No issue
exists for any finding in the audit's remediation clusters 7, 8, 9, 10 or 12.

This matters because five of the twelve regression areas the request asks me to check
are premised on fixes that were never made. Specifically: **resource limits (area 7),
the mail profile (area 8), durable limits and worker metering (area 9), and the email
rendering sanitizer (area 10) do not exist in the codebase.** I report those areas
against what is actually there rather than confirming work that was not done. Area 1
(health), 2 (HSTS), 3 (fetcher), 4 (CI scanning), 5 (Postgres), 6 (MinIO), 11 (prompt
fencing) and 12 (passport expiry) correspond to real, merged changes and are verified
in full.

---

## 1. Summary

### Verdict counts across all 38 findings

| Verdict | Count | Findings |
|---|---|---|
| RESOLVED | 16 | SEC-1, 2, 3, 5, 6, 9, 11, 16, 19, 22, 23, 29, 30, 31, 32, 35 |
| PARTIAL | 5 | SEC-4, 8, 15, 21, 24 |
| INCORRECT | 0 | none |
| ACCEPTED | 5 | SEC-12, 20, 36, 37, 38 |
| OUTSTANDING | 12 | SEC-7, 10, 13, 14, 17, 18, 25, 26, 27, 28, 33, 34 |

Plus the dev-only `npm audit` findings, ACCEPTED with a written rationale.

### Regressions and new issues

| Class | Count |
|---|---|
| Regressions in previously working behaviour | 0 |
| New issues introduced by the remediation | 9 (1 medium-high, 2 medium, 6 low) |
| Pre-existing issues the remediation did not touch | 12 (the OUTSTANDING set) |

**No fix broke anything.** Every consumer of every changed surface was checked and
each still reaches a route, credential or grant it can use. The compose healthchecks,
the operator status path, the SPA, the ops CLIs, the queue, the integrity sweep, the
deletion saga and presigned downloads all work under the new restrictions, verified by
running them rather than by reading them.

The headline defect is not a regression but an incomplete fix: **SEC-8's passport
export expiry has a race that can resurrect an expired export containing erased
content, outside the receipt and outside the integrity sweep.** Two independent
reviews found it and I confirmed it in the code.

### The honest overall picture

The three waves that were done are of high quality. The two highest-blast-radius
findings in the audit, SEC-1 and SEC-2, are genuinely and provably fixed: I probed the
live database and object store directly and every negative property holds. But the
programme stopped after cluster 6 of 14. **Twelve findings, including one that the
audit rated MEDIUM and demonstrated with two working bypasses (SEC-7), remain
untouched and, with one partial exception, unaccepted in writing.**

---

## 2. Finding-by-finding verification

### HIGH

| # | Verdict | Evidence |
|---|---|---|
| SEC-1 | **RESOLVED** | Live probe. `\du` on the running instance shows `cogeto_app`, `cogeto_migrate`, `zitadel_admin`, none superuser; app and worker both connect as `cogeto_app` (`docker exec ... echo $COGETO_DATABASE_URL`). All five negative properties confirmed by executing them as the app role inside rollback-guarded transactions: `ALTER TABLE audit_log DISABLE TRIGGER ALL` fails "must be owner of table audit_log"; `DROP TABLE deletion_receipt` fails "must be owner"; `TRUNCATE`/`DELETE`/`UPDATE` on `audit_log` and `deletion_receipt` all fail "permission denied"; `CREATE TABLE` fails "permission denied for schema public"; connecting to the `zitadel` database fails "User does not have CONNECT privilege". Grants: `audit_log` is INSERT+SELECT only, `deletion_receipt` is INSERT+SELECT+UPDATE only, every other table full DML. All 34 tables owned by `cogeto_migrate`. Graphile RLS policies present on all four `_private_*` tables. No role membership between the three roles; `datacl` grants `cogeto_app` only CONNECT. Provisioned by `db-init.sql`, re-converged after every migration by `applyAppRoleGrants` (`infrastructure/migrations.ts:89-130`), proven by `least-privilege.integration.spec.ts` against the real SQL |
| SEC-2 | **RESOLVED** | Live probe. App key is `cogeto-app`, not the root user `cogeto`. Policy `cogeto-app-rw` is exactly `s3:PutObject/GetObject/DeleteObject` on `cogeto/*` plus `s3:ListBucket/GetBucketLocation/GetEncryptionConfiguration` on the bucket: no `s3:*`, no `admin:*`. Probing with the app's own credential: `mc admin user list`, `mc admin info`, `mc admin policy list` all return Access Denied; `mc encrypt clear` (disabling SSE) Access Denied; `mc mb` (new bucket) Access Denied; `mc ls cogeto` works; `mc encrypt info` reports sse-s3 enabled. Production `s3.` vhost restricted to `method GET HEAD` and `path /cogeto/*`, everything else 403 (`deploy/Caddyfile:76-87`), so `/minio/admin/*` is no longer proxied. `minio-init` self-verifies both directions at provision time (log line: "scoped app credential ready (object access verified, admin API refused)") |
| SEC-3 | **RESOLVED** | Live: `GET /api/health` returns 401 unauthenticated, `GET /api/health/live` returns 200, on both the owner's stack and the fresh one. `@Public()` now defers only the global guard; `live()` is the sole open route and `health()` carries `@UseGuards(HealthAccessGuard)` (`health.controller.ts:43,49-51`). The guard reads `request.socket.remoteAddress` and never consults `X-Forwarded-For`, and no Express `trust proxy` setting exists anywhere, so the loopback path cannot be spoofed from the edge (`health-access.guard.ts:77-80`, spoof test at `health-access.spec.ts:32`). Consumer sweep in Part 3 area 1: all clear |
| SEC-4 | **PARTIAL** | The fence itself is sound: a fresh 72-bit crypto-random boundary per call, and rather than checking for collisions it strips the real markers out of the content before wrapping, so the guarantee does not depend on the boundary staying secret (`model-gateway/untrusted-fence.ts:36-60`). Applied at extraction, verification (both spans), research synthesis and the skill brief's page and fact blocks. New prompt versions are new files with changelogs; `git log --diff-filter=M` over `project/prompts/*/v*.md` since the wave is empty, so nothing was edited in place. Six golden-set injection traps in both languages with a zero-tolerance `injection_violations` gate (`entrypoints/eval.ts:215-223`) inside the required `eval-gate` CI job. **Why PARTIAL:** the fence is not applied at every place untrusted text enters a prompt. `connectors/email-reply-draft.service.ts:131-163` puts a raw third-party email body into a prompt behind a *static, forgeable* delimiter (`<<<ORIGINAL_MESSAGE`), which content can close early; and within one skill-brief prompt the same memory rows are fenced in one block and unfenced in the adjacent open-loop and contradiction blocks (`skills/skill-engine.ts:409-434`). The answer path is deliberately unfenced with a measured rationale recorded in code (`answer-prompt.ts:89-102`: fencing cost chat coverage 86% to 14%), which is a legitimate engineering decision, but the audit table's pointer "(see below)" points at nothing in the audit file |
| SEC-5 | **RESOLVED** | `.github/dependabot.yml` declares `docker` for the three Dockerfile directories and `docker-compose` for `/` and `/project/infra/deploy`. Proven live by open PRs #293 to #306 spanning all five directories. Digests still pinned |

### MEDIUM

| # | Verdict | Evidence |
|---|---|---|
| SEC-6 | **RESOLVED** | `@Controller('integrity')` with `@UseGuards(BearerAuthGuard, AdminGuard)` (`memory/receipts.controller.ts:170-171`). Live: a valid non-admin session gets 403. Its only caller is the System page, which already refuses to render for non-admins |
| SEC-7 | **OUTSTANDING** | Untouched. `connectors/email-parse.ts` has zero commits since the audit; the handler strip at `:107-109` still requires whitespace before `on`, so `<img/src=x/onerror=...>` still survives, and the `javascript:` neutralizer at `:111` still matches only the literal scheme. Sink still `dangerouslySetInnerHTML` at `SourceDrawer.tsx:321`. No parser-based sanitizer dependency exists in any `package.json`; no sandboxed iframe. The CSP `script-src 'self'` remains the only barrier, exactly as the audit described. No acceptance recorded anywhere |
| SEC-8 | **PARTIAL** | The designed path works, verified live end to end on the fresh stack: exported a passport (55642 bytes, ready), deleted a source, and the export flipped to `expired`, the download refused by name ("it was expired because a source it may have contained was deleted"), the receipt carried `"passport_exports_expired":1`, the export's object key appeared in the receipt's `object_keys`, the ZIP was genuinely gone from MinIO afterwards (only the two uploaded files remained), and `GET /api/receipts/verify` returned `{"ok":true,"verified":1}`. **Why PARTIAL:** `PassportExportStore.markReady` updates unconditionally, with no status guard (`passport/passport.store.ts:74-86`). An export that is `pending` when a deletion expires it has no object key yet, so nothing joins the receipt; the worker then finishes assembling it from pre-deletion reads, uploads the ZIP and flips the row back to `ready` with a live key. The result is a downloadable archive of provably erased content that no receipt references and the integrity sweep therefore never checks, living until the retention pass. The code comment at `passport.source-expiry.ts:46-49` acknowledges the flip and calls it "harmless (it is re-expired by the next deletion)", which is not a bound: there may be no next deletion. This is the same over-claiming the finding set out to close, narrowed to a race window |
| SEC-9 | **RESOLVED** | All four events written to the append-only trail with structural metadata only: `passport.export_requested` (`passport.service.ts:59-67`), `export_ready` (`passport-export.executor.ts:106-113`), `export_downloaded` (`passport.service.ts:105-113`), `export_expired` (`passport.source-expiry.ts:77-84`). Metadata-only asserted by `passport-deletion.integration.spec.ts:105-118` |
| SEC-10 | **OUTSTANDING** | `entrypoints/worker-root.module.ts:45-47` still registers the gateway without `budget`, with the comment "the model budget is off here". Worker model traffic remains unmetered and no principal is carried into job payloads |
| SEC-11 | **RESOLVED** | `robotsFor` now calls `followRedirects` (`web-fetch.ts:354-378`), which fetches with `redirect: 'manual'` and runs `refusalFor` on each hop before following. The only remaining raw `fetchImpl` sites are the default, the fixture stub and the one inside `followRedirects`. Two spec cases: a robots redirect into a private address is refused, and a legitimate robots redirect is still honoured, so the fix did not over-correct |
| SEC-12 | **ACCEPTED** | Still present as described: the address is validated then the connection re-resolves by hostname. Deferral rationale recorded in the audit's remediation table and, more usefully for a future reader, in `docs/features/web-research.md:48-52` as an accepted limit with its argument. The stated reason (undici reaches the tree only transitively, at a different major) is true: `package-lock.json` shows undici only under `@qdrant/js-client-rest` at major 6, with dev-only major 7 elsewhere |
| SEC-13 | **OUTSTANDING** | `scripts/operator/cogeto:483-495` still curls the cosign binary with no checksum and no signature check and installs it as root; `fetch_one` (`:549-559`) still pulls deploy assets from `raw.githubusercontent.com` at a mutable tag ref. The unverified surface **grew**: wave 3 added `postgres-init/db-init.sql` to the fetched set (`:542`), so the SQL that provisions database roles is now also fetched unverified |
| SEC-14 | **OUTSTANDING** | The `mail` service has no `profiles:` key in either compose file (dev `:787`, deploy `:571`) and still maps `${COGETO_MAIL_HOST_PORT:-25}:2525`. `scripts/operator/cogeto:599-603` still runs `ufw allow 25/tcp` on every install |
| SEC-15 | **PARTIAL** | The header is present on both edges with sane values and no `preload`: production `max-age=31536000; includeSubDomains` (`deploy/Caddyfile:58`), dev `max-age=300` (`docker/caddy/Caddyfile:56`). `includeSubDomains` is safe: the runbook's DNS table provisions only `s3.` (ACME-terminated HTTPS), `mail.` and `in.` (SMTP, no HTTP). **Why PARTIAL:** on both edges the header sits inside the SPA `handle` block only. I confirmed live: `/` returns HSTS, `/api/health/live` returns none, `/ui/v2/login` returns none, and the whole `s3.` vhost sends none. Browsers that load the SPA are covered; an API-only client or a first contact via an OIDC deep link or a presigned link is not |
| SEC-16 | **RESOLVED** | Verified live in both modes. On the non-demo stack: `pat.txt` is 0 bytes, `bootstrap-state.json` reads `{"revoked": true, ...}`, the init log says "bootstrap PAT revoked and pat.txt blanked, verified by re-auth refusal", and a re-run short-circuits with "zitadel already provisioned and the bootstrap PAT is revoked (SEC-16), nothing to do". On the fresh demo stack the documented residual behaves exactly as written: the PAT is kept (72 bytes), state records `"keptForDemo": true`, and the log states the residual explicitly. Deploy compose requires `ZITADEL_BOOTSTRAP_PAT_EXPIRY:?` at 14 days, generated by the operator script |
| SEC-17 | **OUTSTANDING** | `mem_limit`, `pids_limit`, `cpus` and `deploy.resources` return zero matches in both compose files. No container has any limit |
| SEC-18 | **OUTSTANDING** | All four sites unchanged since the audit: `daily-counters.ts:17` (in-process `Map`), `rate-limit.ts:39`, `model-budget.ts:29-51`, `email-intake.service.ts:83`. The header comment in `daily-counters.ts` argues the design is sufficient, but it predates the audit, which quoted it and filed the finding anyway with the rebuttal that a crash-looping app under attack removes the cap. That rebuttal is unanswered |
| SEC-19 | **RESOLVED** | New `scan` job (`ci.yml:209-291`): `npm audit --omit=dev --audit-level=high` on root and mail, `pip-audit` on the redaction lock, Trivy CRITICAL/HIGH with `exit-code: 1`; the redaction image now builds in `docker-build`. Both allowlist entries are scoped, dated and reasoned (pip-audit `GHSA-537c-gmf6-5ccf`, reviewed 2026-07-30, with rationale; Trivy `skip-dirs` limited to the bundled npm CLI with six named CVEs). No threshold was lowered. Caveat recorded as a new issue: the job is deliberately not a required check |
| SEC-20 | **ACCEPTED** | `release.yml` still prefers `TRUSTSCORES_TOKEN` for the `--admin` merge, unchanged as stated. Acceptance recorded only in the audit's remediation table, on the owner's word; console state is not verifiable from the repo |

### LOW and INFO

| # | Verdict | Evidence |
|---|---|---|
| SEC-21 | **PARTIAL** | The entry exists (`secret-preflight.ts:67`) and is passed to `preflight` in both stacks. But both pass `${SEARXNG_SECRET:-}` while the dev `searxng` service defaults to `${SEARXNG_SECRET:-cogeto-dev-searxng-secret}` (`docker-compose.yml:759`), and `findKnownDevSecrets` skips empty values. Every other secret mirrors its service default precisely so the unset path fires; this one does not, so the audit's exact scenario (a non-localhost dev-compose run with the variable unset, which is the `.env.example` default state) still ships the known secret unrefused |
| SEC-22 | **RESOLVED** | `deployment-hardening.spec.ts` now reads `docker-compose.deploy.yml` and the mail Dockerfile, asserts digests across both compose files and all three Dockerfiles, and adds a `:latest`-comment check across all five files |
| SEC-23 | **RESOLVED** | `image-pins.md` now says spaCy 3.8.13 and `en_core_web_lg-3.8.0`, matching `requirements.txt:13` and the Dockerfile; SearXNG and the deploy stack are in the table. One stale sentence remains in `requirements.txt:14-15` claiming the model is downloaded rather than pinned |
| SEC-24 | **PARTIAL** | The dead `../audits/` link is gone. But the replacement text at `security-overview.md:117-122` now asserts "Audit reports themselves are internal and are not published", while `docs/audits/security-audit-2.0.md` is a tracked file in this public AGPL repository. The public trust claim is wrong again, in the opposite direction |
| SEC-25 | **OUTSTANDING** | `infrastructure/migrations.ts:19-66` still has no advisory lock and no checksum of applied files. Wave 3 touched the file only to append `applyAppRoleGrants` |
| SEC-26 | **OUTSTANDING** | `identity.service.ts:67-69` still sets `expiresAt` from the configured TTL and never reads the token's own `exp`. File unchanged since the audit |
| SEC-27 | **OUTSTANDING** | `rate-limit.ts:39` still has no eviction path |
| SEC-28 | **OUTSTANDING** | Confirmed live: `/api/*` responses carry no security headers on either edge. Wave 1's header work went into the SPA `handle` block only, so nothing changed here |
| SEC-29 | **RESOLVED** | `logger.ts:54-81` adds `*.*.<field>` for all content and secret keys. Depth 4 remains uncovered with an explicit written rationale that log shapes bottom out at three |
| SEC-30 | **RESOLVED** | `deletion-saga.ts:529-565` writes a receipt only when something was erased, with source-row removal counting, so a just-captured note still gets an honest "0 memories" receipt. Verified live: deleting my one-memory note produced a receipt that verified. Tested end to end including the chain re-verify. Note the doc contradiction recorded as a new issue |
| SEC-31 | **RESOLVED** | Both `.dockerignore` files exist and are allowlist-style; the redaction one denies `**/__pycache__` and `**/*.py[cod]` inside the allowed tree, killing the audited `app/__pycache__` leak |
| SEC-32 | **RESOLVED** | `sourceMap: false` in `tsconfig.build.json` only, so dev keeps maps. `@cogeto/shared` never emitted them. The web SPA still emits sourcemaps (`vite.config.ts:30`), which is the same class in a sibling build, but it is pre-existing and frontend source is public anyway |
| SEC-33 | **OUTSTANDING** | `agents/approval.service.ts:244-253` still gates on `orgId` only for non-content-bearing actions. Unchanged. Notably this finding appears in **no** remediation cluster in the audit, so it was never scheduled |
| SEC-34 | **OUTSTANDING** | Wave 3 rewrote the app and migrate connection strings without an `sslmode` parameter, but node-postgres defaults to TLS off, so traffic is still plaintext; Zitadel's `SSL_MODE: disable` survives verbatim (`deploy.yml:487,493`) and the server enables no TLS. **The owner's claimed acceptance is recorded nowhere**: not in the audit's remediation table, not in `docs/security/` or `docs/operations/`, not in any wave PR body, not in an issue, not in a code comment |
| SEC-35 | **RESOLVED** | All four locations now record real release tags (`minio RELEASE.2025-09-07T16-13-09Z`, `mc RELEASE.2025-08-13T08-35-41Z`) beside digests that are byte-identical to the baseline. Confirmed live: the running `mc` reports exactly `RELEASE.2025-08-13T08-35-41Z`. `deployment-hardening.spec.ts` now fails CI on any future `:latest` comment |
| SEC-36 | **ACCEPTED** | Present (`web/src/auth/oidc.ts:106`). Rationale recorded in `docker/caddy/Caddyfile:36-41` as an explicit v1 tradeoff, plus the audit's INFO row |
| SEC-37 | **ACCEPTED** | Present (`oidc.ts:56-65,92-107`). Rationale recorded only in the audit's own INFO row |
| SEC-38 | **ACCEPTED** | By design; comments in both compose files state the worker holds the full keypair because it signs. The audit's suggested follow-up, restating in `docs/security/` that the worker is also the process handling untrusted mail and web content, was not done |
| dev-only npm audit | **ACCEPTED** | `ci.yml:206-208` states plainly that `--omit=dev` is deliberate and not a lowered threshold, naming the 10 known dev-tree highs and why they never reach a shipped image |

---

## 3. Regression hunt in the twelve breaking-risk areas

**1. Health endpoints.** Verified live: `/api/health` 401 unauthenticated, `/api/health/live` 200. Every consumer traced and each reaches a route it can use:

| Consumer | Route | Reachable |
|---|---|---|
| Dev compose app healthcheck (`docker-compose.yml:182`) | `/api/health/live` | yes, public |
| Deploy compose app healthcheck (`deploy.yml:161`) | `/api/health/live` | yes, public |
| Demo bootstrap (`demo/bootstrap.ts:32`) | `/api/health/live` | yes |
| Operator `status` and `features` (`cogeto:656,1068`) | `/api/health` via `compose exec` inside the container | yes, loopback path, full detail |
| Web client (`web/src/api.ts:125`) | `/api/health` with bearer | yes, trimmed for non-admins |
| Runbook DNS cutover curl (`operator-runbook.md:458`) | `/api/health/live` | yes |

**No healthcheck points at the guarded route, so no container can restart-loop.** I confirmed the fresh stack reached healthy on every service. The loopback check cannot be spoofed from the edge: it reads the socket address and no `trust proxy` setting exists. A non-admin authenticated user sees status, per-check ok and latency, capability ids and states, and job states, with error strings and queue depths stripped.

**2. HSTS.** Verified above (SEC-15). Present on production with one year and no preload, dev at five minutes, `includeSubDomains` compatible with every subdomain the runbook provisions. The gap is scope: SPA responses only, confirmed by live curl against `/api/*`, `/ui/*` and the `s3.` vhost. One note for local work: HSTS is host-scoped and port-agnostic, so after visiting `https://localhost` a browser upgrades `http://localhost:<any-port>` for five minutes, which can transiently affect other local projects. The short max-age is the deliberate mitigation.

**3. The fetcher's address pinning.** This area's premise needs correcting: address pinning was **not** implemented (SEC-12 is deferred). What I verified instead is that the wave-1 robots change did not weaken anything, driving the real `WebFetchService` against the live internet from inside the container:

| URL | Result |
|---|---|
| `https://example.com/` (Cloudflare CDN) | fetched |
| `http://example.com/` (http to https redirect) | fetched |
| `https://en.wikipedia.org/wiki/European_Union` | fetched |
| `https://www.cloudflare.com/` | fetched |
| `https://expired.badssl.com/` | refused, unreachable |
| `https://wrong.host.badssl.com/` | refused, unreachable |
| `http://169.254.169.254/latest/meta-data/` | refused_address |
| `http://10.0.0.5/`, `http://127.0.0.1:9000/`, `http://[::1]:8080/` | refused_address |

**Certificate validation is intact.** The expired and wrong-host certificates are both refused, which is the specific failure mode this area warns about, and it did not happen: TLS still validates against the real hostname because the connection is still made by hostname. That is also precisely why the rebinding window (SEC-12) remains open, a coherent trade-off rather than a silent weakening. Redirects and CDN-hosted pages fetch normally. IPv6 literals parse and refuse correctly; external IPv6 fetching could not be tested because the Docker bridge has no IPv6 route, which is an environment limit, not a code defect.

One thing worth stating so it is not mistaken for a bug: in demo mode the fetcher is fixture-backed and returns 404 for any URL outside the bundled set (`web-fetch.ts:177-187`). My first real-URL attempts on the demo stack returned 404 for that reason, not because fetching is broken.

**4. CI scanning.** The `scan` job runs on every PR and push and does what the audit asked. Both allowlist entries carry a finding id, a rationale and a review date of 2026-07-30, not a blanket suppression. Dev-only highs are excluded via `--omit=dev` with a written justification rather than a lowered threshold, so they do not fail the build. **The job is deliberately not a required check** (`ci.yml:8-11`), so a red scan does not block a merge; promoting it is an owner branch-protection action.

**5. Postgres least privilege.** Verified by direct probing rather than reading, results under SEC-1. The runtime-failure hunt across every operation class found full coverage, and I confirmed the risky ones by running them: the queue works (health reports 0 queued, 0 dead-lettered), the outbox and `add_job` work (every capture I made was processed), the integrity sweep ran clean under the app role ("1 receipt, 3 identifiers checked, 2 objects scanned, 66 payloads compared, 0 alerts, chain ok"), the deletion saga ran and inserted a receipt, audit inserts happen (41 rows on the owner's stack), and a dreaming cycle completed. Sequence grants are present for the graphile sequences; the public schema has no sequences to miss. Grants re-converge after every migration run because `applyMigrations` calls `applyAppRoleGrants` last, and db-init default privileges cover new tables immediately. Migrations run as `cogeto_migrate`, Zitadel bootstrap as `zitadel_admin`, verified in both compose files.

**6. MinIO scoped credentials and the s3 vhost.** Results under SEC-2. Additionally verified end to end: uploading a PDF wrote an object under the scoped credential; a passport export was written, presigned (the URL is signed `X-Amz-Credential=cogeto-app`, not root) and then erased by the deletion worker leg; the boot-time SSE assertion works under the scoped account (`minioEncryption ok, SSE-S3 default encryption on` in the health report), because `s3:GetEncryptionConfiguration` is in the policy. The upload path is a hand-rolled SigV4 client using single-shot PUT with no multipart, and the only presign method is GET, so the vhost's GET/HEAD restriction cannot break an upload. `ensureBucket` and `setBucketEncryption`, which the scoped user cannot perform, are test and dev-harness only.

**7. Resource limits.** **Not implemented.** Zero limits in either compose file. Nothing to compare against a working set. The audit's scenario stands unchanged: the redaction sidecar is documented at about 1 GB RSS and nothing prevents a runaway worker or an index rebuild from OOM-killing Postgres.

**8. The mail profile.** **Not implemented.** The `mail` service has no profile in either file, port 25 is opened unconditionally, and the operator script's ufw rule is ungated. There is consequently nothing for the capability registry or `cogeto features` to reflect. Email intake itself does work: on the fresh stack I allowlisted a sender, sent a real message over SMTP to the mail container, and the parsed email landed in `email_message` with the right subject and sender.

**9. Durable limits and worker metering.** **Not implemented.** Counters, rate-limit windows, the model budget and the per-sender intake window are all still in-process maps that a restart clears, and worker model calls are still unattributed. There is no new persistence, so the sub-questions about hot rows, lock contention and old payload shapes do not arise.

**10. Email rendering.** **Not implemented.** The regex sanitizer is not gone and was not supplemented: `email-parse.ts` has zero commits since the audit, both demonstrated bypasses still work against the code as written, there is no parser-based sanitizer dependency and no sandboxed iframe. The sink is still `dangerouslySetInnerHTML`. Normal mail does render correctly, verified through intake on the fresh stack, but that was never in doubt.

**11. Prompt fencing.** Covered under SEC-4. The fence cannot be forged by content because the boundary is fresh per call and the markers are stripped from content first. Prompt versions are new files with changelogs. Traps exist and are gated at zero tolerance in a required CI job. **Eval deltas across the prompt change (v1.2.0 to v1.3.0 trust scores):** extraction precision 0.7923 to 0.7958 (up), extraction recall 0.9135 to 0.9196 (up), verification agreement 0.8919 to 0.8690 (down 2.3 points, inside the documented 79.4 to 91.2 variance band and still far above the 0.75 gate), dedup and contradiction unchanged, chat 24/24 to 23/24 with the known grader-variance case `atlas_scope`. The corpus grew from 76 to 86 cases because the traps are in the denominator. **No evidence the fence degraded extraction quality.** Note that v1.3.0 published the failed chat case without the explanatory note that precedent (v0.9.2) set. The one gap is coverage, not quality: see the reply-draft and skill-brief entry points under SEC-4.

**12. Passport expiry in the deletion saga.** Verified live end to end, results under SEC-8: export expired, download refused by name, receipt counted it, object keys joined the receipt, bytes erased from MinIO, chain verified unbroken, and the four lifecycle audit events are written. Empty enumerations no longer mint receipts, while a source-row-only deletion honestly does. Historical receipts still verify because the new field is additive-optional and omitted when zero, so old receipts canonicalize byte-identically. The residual is the `markReady` race.

---

## 4. New issues introduced by the remediation

| # | Severity | Issue | Evidence | Fix scope |
|---|---|---|---|---|
| N-1 | **Medium-high** | Passport export race: `markReady` has no status guard, so an export expired while `pending` is flipped back to `ready` with a live key after the deletion, containing erased content, referenced by no receipt and invisible to the sweep | `passport/passport.store.ts:74-86`; the flip is acknowledged and mislabelled "harmless" at `passport.source-expiry.ts:46-49` | One line: `markReady ... WHERE status = 'pending'`; on zero rows delete the just-written object |
| N-2 | **Medium** | Forged-framing guard false positives, invisible to the gates. The regex is case-insensitive and `REFERENCE TIME` needs no colon, so a line beginning "Reference time for the measurement" or "Source type: interview" marks the rest of the document as forged; with the paraphrase fallback, facts grounded before the line can also be dropped, silently | `ingestion/pipeline/extract.stage.ts`, `FORGED_FRAMING_LINE`; the precision corpus contains no benign document carrying these labels, so no gate can see this class | Tighten the regex to the exact colon-bearing label shapes, case-sensitive; add one benign golden case |
| N-3 | **Medium-low** | A stale operator script bricks an upgrade. The deploy compose now requires five new `:?` variables, but the backfill lives only in the new script's `ensure_wave3_secrets`, and the script does not self-update, so an operator running the installed copy fetches the new compose and dies on interpolation after assets were already swapped | `deploy.yml:70,82,234-236,256,293-295,342,492,513`; `scripts/operator/cogeto` | Documented in the runbook; make the script self-check its version before fetching |
| N-4 | **Low** | `security-overview.md` overstates the fence. It claims an explicit clause in "extraction, verification, **answer**, research synthesis, skill brief"; `project/prompts/answer/v0007.md` contains zero injection-defence language (grep count 0). This is a public trust document | `docs/security/security-overview.md:63-64` | Reword to match the deliberate answer-path decision |
| N-5 | **Low** | `deletion-and-receipts.md` contradicts the shipped code, describing the abandoned first SEC-30 implementation ("no receipt is written" when a source row is erased) while the code in the same commit mints one | `docs/security/deletion-and-receipts.md`, "An empty enumeration mints no receipt" | Update the paragraph to the narrowed rule |
| N-6 | **Low** | The SEC-24 fix replaced a broken link with a false claim that audit reports are not published, while the audit report is tracked in this public repository | `docs/security/security-overview.md:117-122` | Reword, or move the report out of the repo |
| N-7 | **Low** | Over-grant: `cogeto_app` holds full DML on `graphile_worker.migrations`, so the app role can corrupt the queue's migration ledger. The public-schema `cogeto_migrations` got a read-only carve-out; the graphile equivalent did not | `infrastructure/migrations.ts`, `applyAppRoleGrants` | Add the same carve-out |
| N-8 | **Low** | Process risk: db-init default privileges grant TRUNCATE on every future table to `cogeto_app`, so a future append-only table needs a manual carve-out that nothing prompts for | `db-init.sql:142-149` | Add a checklist line where append-only tables are defined |
| N-9 | **Low** | Dev-seed services race the new one-shots: `seed-object` and `seed-orphan` inherit the restricted role and scoped S3 credential but depend only on postgres, minio and qdrant, not on `db-init`, `migrate` or `minio-init` | `docker-compose.yml:636-660` | Add the three one-shots to `depends_on` |

Two further observations that are consequences rather than defects: the redacted health report reports queue counts as `0` rather than omitting them, which is a confidently false number for a non-admin API consumer (`health-access.guard.ts:118`); and the deletion confirm dialog does not warn that every passport export will be expired, so deleting one trivial note silently kills a just-generated export (`SourceDrawer.tsx:145-155`).

### Checks that came back clean

- **Environment consistency, boundaries and invariants all pass.** `npm run boundaries`: 0 violations over 503 modules and 2595 dependencies. `npm run lint`: clean, including the doc-dash guard over 83 markdown files. `env-consistency`, `deployment-hardening`, `operator-script` and `health-access` specs: 72 tests passed. Full `npm test`: **687 passed, 2 skipped** on the server workspace plus **81 passed** on web, exit 0.
- **No new module coupling.** The passport module reaches memory only through the barrel; the memory module gained no passport import, the saga sees a `DerivedCascade` interface wired as DI adapters in both root modules.
- **No over-broad grant defeats the role split**, beyond N-7 and N-8. No role membership between the three roles, no PUBLIC database grants, `cogeto_app` owns no tables.
- **The scoped storage policy is not effectively admin**, proven by attempting the admin operations and being refused.
- **No guard denies a legitimate surface.** Every web client route was cross-checked against the guard changes.
- **No header change breaks the SPA or the API client.** The SPA loads and the full session flow works.
- **New environment variables are documented**: all six are in `.env.example`, enforced with `:?` in the deploy compose, set by the operator install, backfilled by upgrade, and asserted by tests. The only gap is N-3, the stale-script path.
- **Compose ordering is acyclic and the one-shots are idempotent**, verified by re-running `db-init`, `minio-init` and `zitadel-init` on a live stack: all exited 0, db-init reported "roles, databases and default privileges converged", minio-init re-verified the scoped credential, zitadel-init short-circuited on the revoked-PAT state.

---

## 5. Functional verification

Performed on a stack booted from genuinely empty volumes in an isolated compose
project, with the demo profile enabled to obtain a headless session. Every one-shot
exited 0 and every service reached healthy.

| Step | Result | Observed behaviour |
|---|---|---|
| Fresh boot from empty volumes | **PASS** | `preflight`, `instance-keys-init`, `machinekey-init`, `db-init`, `migrate`, `minio-init`, `zitadel-init` all exited 0; app, worker, caddy, mail, postgres, qdrant, minio, searxng, zitadel all healthy |
| Reach a working login | **PASS** | SPA served 200; `/api/config` advertised the password gate; `POST /api/config/demo-login` returned a session; `GET /api/me` resolved it to Ana Kovač with `isAdmin:false` |
| Capture a note | **PASS** | `POST /api/notes` returned an id; status reached `done`; one memory extracted |
| Upload a document | **PASS** | A `text/plain` upload was correctly refused by the type allowlist; the real PDF uploaded and wrote an object under the scoped MinIO credential |
| Ingest an email through intake | **PASS** | Allowlisted a sender, sent a real message over SMTP to the mail container on 2525, and the parsed message landed in `email_message` with the correct subject and sender. Note the mail profile does not exist (SEC-14), so mail is always on |
| Chat question citing memory | **PASS** | Answer returned with per-claim citations and `"citationViolations":0` |
| Research capture through the approval gate | **PASS** | Proposed a run, approved it with edited text (the gate recorded the exact approved text), re-approving with different text returned **409**, and capture through the approved run stored a page. Real-URL capture is not possible on a demo stack because the fetcher is fixture-backed; the live fetcher was exercised separately, see area 3 |
| Delete a source, receipt verifies | **PASS** | Impact preview reported 1 memory; deletion returned a receipt; `GET /api/receipts/verify` returned `{"ok":true,"verified":1,"confirmed":1,"pending":0}` |
| Export a passport and download it | **PASS (with an environment limit)** | Export reached ready at 55642 bytes; the download endpoint minted a presigned URL signed `X-Amz-Credential=cogeto-app`. The bytes could not be fetched over that URL because the `s3.` vhost lives behind the `consoles` profile on the dev stack; object existence was confirmed directly in MinIO instead |
| Delete a source afterwards, export expired | **PASS** | Export status flipped to `expired`; download refused with "it was expired because a source it may have contained was deleted"; the receipt carried `"passport_exports_expired":1` and the export's object key in `object_keys`; the ZIP was gone from MinIO afterwards |
| Integrity sweep | **PASS** | Ran under the restricted role: "1 receipt, 3 identifiers checked; 2 objects scanned, 66 payloads compared (0 healed); 0 new alerts, 0 on record; chain ok" |
| Dreaming cycle | **PASS** | Completed under the restricted role and recorded a run |
| Capabilities report honest state | **PASS** | The registry reported research as on with the detail "sandbox: web discovery serves bundled fixture pages, never the live web", which is exactly the behaviour I had just observed empirically, and demo as on with "sandbox mode". Non-admins receive the trimmed report; `/api/integrity` returns 403 to a non-admin |

The throwaway project was destroyed with its own volumes; the owner's stack was
restarted and its data verified intact (36 memories). The working tree is clean.

---

## 6. Accepted-risk register

| Finding | Risk in plain language | Rationale | Where it is recorded |
|---|---|---|---|
| SEC-12 | DNS rebinding: a hostile site can answer a public address to the guard and a private one to the fetch, so an internal page could be captured | Pinning needs a custom dispatcher; undici reaches this tree only as a transitive Qdrant dependency at a different major, so depending on it would be undeclared and a lockfile change could drop it from the production image. Bounded by single tenancy, explicit user invocation and budget caps | Audit remediation table; `docs/features/web-research.md:48-52`. Both verified accurate |
| SEC-20 | A long-lived admin PAT can merge to protected `main` without review | Owner states it is handled in the GitHub console; the workflow was deliberately left untouched | Audit remediation table only, on the owner's word. Console state not verifiable from the repo |
| SEC-36 | The bearer token sits in `sessionStorage`, so an XSS would read it | Accepted for v1; the strict `script-src 'self'` is the real mitigation and single tenancy bounds exposure | `project/infra/docker/caddy/Caddyfile:36-41`, plus the audit INFO row |
| SEC-37 | The `id_token` is never verified client-side and the auth request carries no `nonce` | The access token is validated server-side via userinfo, and PKCE plus `state` are correct | Audit INFO row only |
| SEC-38 | The worker holds the receipt-signing private key and is also the process that parses untrusted mail and web pages | By design: the worker is what signs receipts | Comments in both compose files, plus the audit INFO row. The audit's suggested restatement in `docs/security/` was not written |
| Dev-only npm audit highs | Ten known high advisories in the dev tree | `--omit=dev` is deliberate and not a lowered threshold: these packages are never installed into a shipped image | `.github/workflows/ci.yml:206-208`, and PR #292's body |
| SEC-16 demo residual | The dev sandbox keeps its bootstrap PAT | A sandbox holds no real data and is disposable | `zitadel-init/init.mjs:36-38,448-451`, both compose files, `docs/security/isolation-and-access.md`, and the audit table. Verified live: the fresh demo stack keeps the PAT and says so |

**Two acceptances are asserted but not written down, and should be corrected:**

1. **SEC-34 (plaintext Postgres traffic).** The owner is said to have accepted it. No document in the repository, no issue, no PR body and no code comment records that acceptance or its rationale. As written, it is OUTSTANDING, not ACCEPTED.
2. **SEC-37** rests solely on a row inside the audit report. If that report is ever
   treated as superseded, the rationale disappears with it.

---

## 7. Residual risk in plain language

**What a competent attacker could still do against a correctly installed instance.**

The realistic entry points are the ones the remediation did not close. A hostile email
from an allowlisted sender is the strongest: the HTML sanitizer is still five regexes
with two demonstrated bypasses, and the rendered body still goes through
`dangerouslySetInnerHTML`. The only thing standing between that and script execution
in the owner's session is a single Content-Security-Policy header. If that header is
ever weakened, misconfigured or bypassed, hostile mail becomes account compromise, and
content and phishing injection already land today.

The same untrusted content can still poison memory. Fencing makes the extractor much
harder to steer, and the traps prove the obvious payloads are caught, but a
sufficiently persuasive document can still land a false claim as a stored fact. It
will be attributed and deletable and it cannot change visibility, ownership or
provenance, but a user who trusts the answer will be misled. Two seams are still
weaker than the rest: a reply draft puts a raw third-party email body behind a static
delimiter that the email itself can close, and the answer path is unfenced by
deliberate choice.

An attacker who gets any code execution in the app or worker is now genuinely
contained, which is the programme's biggest win. They cannot rewrite the audit trail,
cannot drop the receipt ledger, cannot reach the identity database and cannot escape
the `cogeto` bucket or touch the MinIO admin API. I verified each of those by trying
them. What they can still do is exhaust the instance: no container has any resource
limit, so a runaway process can OOM-kill Postgres and take the instance down, and
every abuse counter lives in memory, so a crash-loop or a redeploy resets the model
budget and the ingest quota. Worker-side model spend is not metered at all, so work
enqueued up to the ingest quota drives unbounded cost.

Every instance also runs an internet-facing SMTP listener whether or not the customer
uses email, with no supported way to turn it off, so any Haraka or mailparser
vulnerability is remotely reachable everywhere. Database traffic inside the compose
network is plaintext. And the installer still terminates its entire image-provenance
chain in an unverified `cosign` binary downloaded as root over TLS, now alongside an
unverified `db-init.sql` that provisions the database roles, so anyone who can
substitute those assets gets root and a silently green signature check.

**What remains unverified.** Advisory applicability for the pinned images was not
checked against live databases. GitHub console state (branch and tag protection, the
`TRUSTSCORES_TOKEN` replacement, secret scanning, the write roster) is not readable
from the repository and the SEC-20 acceptance rests on it. I did not exercise an
upgrade from a pre-wave-3 instance, so the ownership-adoption path in `db-init.sql`
and the stale-operator-script failure (N-3) are reasoned about rather than observed.
External IPv6 fetching could not be tested because the Docker bridge has no IPv6
route. The demo-reset `TRUNCATE ... CASCADE` path under the restricted role was not
run. The passport ZIP could not be downloaded over the presigned URL on a dev stack
because that vhost is profile-gated, so the last hop of that path is verified by
object inspection rather than by an HTTP GET. And the N-1 race was confirmed by
reading the code and reasoning about the interleaving; I did not construct the timing
window at runtime.
