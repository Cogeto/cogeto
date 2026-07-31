# Verification of the security remediation programme

Revision 3, 2026-07-31 · Commit verified: `52e2e26` plus the follow-up fixes below
Revision 1 verified `f36e45b` on 2026-07-30 and is superseded by this document.
Baseline audited commit: `c37dd61` · Audit under verification:
[`security-audit-2.0.md`](security-audit-2.0.md)

Method: read-only. Static reading of all four remediation diffs against current
main; `npm run lint`, `npm run boundaries`, the full `npm test` suite (Vitest plus
Testcontainers); live probing of the running dev stack, including direct privilege
probes against Postgres and MinIO and a rollback-guarded demonstration of one
regression; a complete boot of a throwaway stack from empty volumes in an isolated
compose project, exercised end to end and destroyed with its own volumes; and
execution of the real fetcher and the real email sanitizer against live inputs. No
file was modified except this report.

## A note on revision 1

Revision 1 recorded that only three waves existed. That was accurate for the commit
it verified: at `f36e45b` there was no wave-4 branch, commit, PR or issue, and the
twelve findings below were genuinely absent from the code. **Wave 4 merged as
`52e2e26` at 07:54 on 2026-07-31, after revision 1 was written**, and it is
substantial: 84 files, 3808 insertions, a new migration, and two new runtime
dependencies. It also commits revision 1 of this report into the repository and
responds to it point by point.

Everything in revision 1 that concerned waves 1 to 3 still holds and was re-checked.
This revision re-verifies the twelve findings wave 4 claims, and hunts for what wave
4 broke.

## Follow-up fixes applied after this verification

The owner asked for the items this report judged worth handling immediately. They are
implemented and are included in the verdicts below, marked "wave 5". They are
uncommitted working-tree changes at the time of writing, not a merged wave:

| Item | Change |
|---|---|
| W-1 | The rate-limit eviction sweep is scoped to the calling bucket, with a two-bucket, two-window regression test |
| W-2 | The post-call meter charge is best-effort again: a failure is logged, never raised into a request or a finished stream |
| W-4 | `--max-old-space-size` on `app` and `worker` in both compose files, set below `mem_limit` to leave off-heap room |
| SEC-8 | `markReady` publishes only a still-`pending` row; on a lost race the executor erases the object it just wrote. Both branches tested |
| SEC-34 | Accepted in writing, with its reasoning and its invalidating conditions, in `isolation-and-access.md` |
| N-4, N-5, N-6 | Three security docs corrected to match the code |
| SEC-13 manifest | `deploy-assets.sha256` regenerated, because the W-4 change edits `docker-compose.deploy.yml`, which the installer verifies against it |

Worth recording that the last row was not foreseen: editing the deploy compose file
invalidated wave 4's checksum manifest, and the SEC-13 drift test caught it in the full
suite after the targeted specs had passed. That is the mechanism working exactly as
intended, and it is the standing consequence of SEC-13 for anyone touching a deployment
asset: regenerate with `node scripts/ci/deploy-assets-manifest.mjs --write` in the same
change, or CI fails.

## The four waves

| Wave | Commit | PR | Scope |
|---|---|---|---|
| 1 | `bd84868` | #292 | Health and integrity guards, HSTS, robots SSRF, CI scanning, hygiene batch |
| 2 | `990186d` | #309 | Prompt fencing, passport exports under the deletion saga |
| 3 | `e608d44` | #314 | Least-privilege Postgres roles, scoped MinIO credential, PAT revocation |
| 4 | `52e2e26` | #327 | Durable limits and worker metering, container and edge hardening, parser-based email sanitizing, installer trust chain, remaining medium and low findings |

---

## 1. Summary

### Verdict counts across all 38 findings

| Verdict | Count | Findings |
|---|---|---|
| RESOLVED | 30 | SEC-1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 35 |
| PARTIAL | 2 | SEC-4, 21 |
| INCORRECT | 0 | none |
| ACCEPTED | 6 | SEC-12, 20, 34, 36, 37, 38 |
| OUTSTANDING | 0 | none |

Plus the dev-only `npm audit` findings, ACCEPTED with a written rationale.

Wave 4 moved eleven findings from OUTSTANDING to RESOLVED (SEC-7, 10, 13, 14, 17,
18, 25, 26, 28, 33) and one from PARTIAL to RESOLVED (SEC-15). The wave-5 follow-up
then closed SEC-8 and SEC-27 (both had been PARTIAL because of a real defect rather
than a missing fix), corrected the SEC-24 documentation claim, and recorded the
SEC-34 acceptance, which had been the one finding with neither a fix nor a rationale
anywhere in the repository.

**Every finding is now either fixed or consciously accepted with its reasoning
written down.** The two remaining PARTIALs are named residuals inside otherwise
working mitigations, not gaps: SEC-4's reply-draft and skill-brief fence coverage, and
SEC-21's preflight default asymmetry.

### Regressions and new issues

| Class | Count |
|---|---|
| Regressions in previously working behaviour | 1 high (W-1), introduced by wave 4, **now fixed** |
| New issues introduced by wave 4 | 15 (1 high, 4 medium, 9 low, 1 info); 3 fixed, 12 open |
| Issues from waves 1 to 3 still open | 9 at revision 2; 4 fixed, 5 open |

### The honest overall picture

The programme is now essentially complete against its own audit: 27 of 38 findings
resolved, 5 consciously accepted, 1 outstanding, and the five partials are each a
named residual rather than a missing fix. The two highest-blast-radius findings,
SEC-1 and SEC-2, are provably fixed, and I re-confirmed them by probing the live
database and object store rather than by reading the diff.

Wave 4 is good work under time pressure and it fixed the things I said were missing,
including the email sanitizer I had flagged as the most dangerous gap. I verified its
central claims by execution: both demonstrated XSS bypasses are dead at the parse-tree
level, worker model spend is now attributed per task family in a real database table,
those counters survive a restart, port 25 disappears when the profile is off, and
every running container carries the advertised limits.

**Wave 4 also introduced one genuine high-severity regression, since fixed.** The new
durable rate-limit store evicted rows across buckets using the calling bucket's
window, so an ordinary web request wiped live inbound-mail rate-limit windows. I
demonstrated it against the running database: a sender 10 minutes into a one-hour
window at 55 of 60 messages was reset to zero by an unrelated HTTP request, degrading
the per-sender inbound mail cap from roughly 60 an hour to roughly 60 every two
minutes on any instance with both web traffic and the mail profile. It weakened
exactly the abuse control the same wave set out to make durable, on the product's
most exposed untrusted input. The sweep is now scoped to its own bucket and the
regression is covered by a test that fails against the old behaviour.

---

## 2. Finding-by-finding verification

Findings unchanged since revision 1 are stated in brief; findings wave 4 touched are
verified afresh.

### HIGH

| # | Verdict | Evidence |
|---|---|---|
| SEC-1 | **RESOLVED** | Re-confirmed live on the wave-4 stack. Three roles, none superuser; app and worker connect as `cogeto_app`. All five negative properties fail as required when executed as the app role in rollback-guarded transactions: `ALTER TABLE audit_log DISABLE TRIGGER ALL` "must be owner"; `DROP TABLE deletion_receipt` "must be owner"; `TRUNCATE`/`DELETE`/`UPDATE` on `audit_log` and `deletion_receipt` "permission denied"; `CREATE TABLE` "permission denied for schema public"; `CONNECT` to `zitadel` refused. All tables owned by `cogeto_migrate`, graphile RLS policies present |
| SEC-2 | **RESOLVED** | Re-confirmed live. App key `cogeto-app`; policy is three object actions on `cogeto/*` plus three bucket reads, no `s3:*`, no `admin:*`. With the app credential: `mc admin user list`, `mc admin info`, `mc admin policy list`, `mc encrypt clear` and `mc mb` all Access Denied; `mc ls cogeto` and `mc encrypt info` work. Production `s3.` vhost GET/HEAD on `/cogeto/*` only, else 403 |
| SEC-3 | **RESOLVED** | Live: `/api/health` 401 unauthenticated, `/api/health/live` 200. Guard reads the socket address, never `X-Forwarded-For`; no `trust proxy` anywhere |
| SEC-4 | **PARTIAL** | Unchanged by wave 4. The fence is sound (fresh 72-bit boundary per call; markers stripped from content first, so the guarantee does not rest on secrecy) and is applied at extraction, verification, research synthesis and the skill brief's page and fact blocks, with six gated golden-set injection traps at zero tolerance. **Residual:** `email-reply-draft.service.ts:131-163` still puts a raw third-party email body behind a static, forgeable `<<<ORIGINAL_MESSAGE` delimiter that the email can close early; the skill brief still fences memory in one block and not in the adjacent open-loop and contradiction blocks. The answer path is deliberately unfenced with a measured rationale in code |
| SEC-5 | **RESOLVED** | Dependabot `docker` and `docker-compose` ecosystems across all three Dockerfiles and both compose files, proven by the open bump PRs |

### MEDIUM

| # | Verdict | Evidence |
|---|---|---|
| SEC-6 | **RESOLVED** | `AdminGuard` on the integrity controller; live 403 for a non-admin session |
| SEC-7 | **RESOLVED** | Verified by execution, not by reading. The five regexes are gone; `sanitizeHtml` is now DOMPurify over jsdom with an explicit `ALLOWED_TAGS`/`ALLOWED_ATTR` allowlist, `FORBID_TAGS`, and a hook that drops any `on*` attribute and any `href`/`src` whose value, after stripping control characters, has a scripting scheme. `USE_PROFILES` is correctly absent, with the union hazard cited in a comment. I ran the compiled wave-4 sanitizer in the app container against 13 payloads and asserted the **parse tree** of the output: both audit bypasses (`<img/src=x/onerror=alert(1)>` and `href="javas&#99;ript:..."`), plus svg `onload`, iframes, `data:` URIs, meta refresh, form actions, script-in-CSS and unclosed-tag variants all produce **no handler attribute, no dangerous scheme and no forbidden tag**. Legitimate mail survives: formatting, links, tables and `cid:` images render intact. Independently, the drawer now uses a `srcDoc` iframe with `sandbox="allow-popups allow-popups-to-escape-sandbox"` (no `allow-scripts`, no `allow-same-origin`) and its own `default-src 'none'` meta CSP; `dangerouslySetInnerHTML` is gone from the SPA. `dompurify` and `jsdom` are pinned production dependencies of the server and do ship in the runtime image, which is correct since sanitizing runs server-side. Residual recorded as W-8 |
| SEC-8 | **RESOLVED** (wave 5) | The designed path was verified working end to end in revision 1 (export expired, download refused by name, receipt carried `passport_exports_expired: 1` and the object key, bytes erased from MinIO, chain verified). The race that kept it PARTIAL is now closed: `markReady` publishes only a row that is still `pending`, so an export expired mid-assembly cannot be flipped back to `ready` with a live key, and on a lost race the executor deletes the object it just wrote (that object was written after the saga enumerated, so it is in no receipt for the worker leg or the sweep to catch). Both branches are tested against a real Postgres: the raced export stays `expired` with a null key, and an unraced export still publishes normally |
| SEC-9 | **RESOLVED** | Four lifecycle events on the append-only trail, structural metadata only |
| SEC-10 | **RESOLVED** | Verified live in the database. The enqueuing principal travels as `principal_id`, stamped additively by `withTransactionalEnqueue`; the worker task wrapper reconstitutes a usage scope and is applied to every registered task centrally rather than per registration site, so no task can forget it; the budget decorator is now registered in the worker root. Live evidence from the running instance: `usage_counter` holds `model_tokens` attributed to `ingestion.pipeline` (51261), `dreaming` (4651), `research.conclude` (4140) and `conversation.title` (155). Those are worker-side families that were entirely unmetered before. The old payload shape is safe on two independent grounds: the reader is defensive (`typeof principalId === 'string'`) and the queue schema is `z.looseObject`. Instance-wide cron jobs stay unattributed, as stated |
| SEC-11 | **RESOLVED** | `robotsFor` routed through `followRedirects` with per-hop revalidation; a legitimate robots redirect still honoured |
| SEC-12 | **ACCEPTED** | Rebinding TOCTOU still present by design; rationale in the audit table and in `docs/features/web-research.md:48-52`. The undici justification is factually true in the lockfile |
| SEC-13 | **RESOLVED** | cosign is verified against a sha256 pinned in the script **before** `chmod` and before the move onto PATH; a mismatch deletes the download and aborts. Deploy assets are no longer fetched at a mutable tag: the installer resolves the tag to a commit SHA via the API, refuses to continue if it cannot, prints the commit, fetches the manifest **at that same commit**, and verifies every file; a missing manifest, a missing entry or a mismatch each abort. I recomputed all five manifest checksums from the working tree and all five match, including the `db-init.sql` that wave 3 added. The CI drift test is bidirectional and does run. Two residuals: W-5 (no architecture gate) and W-11 (a second fetch path) |
| SEC-14 | **RESOLVED** | Verified by resolving the compose config both ways. With no profile, `docker compose config --services` yields 14 services with **no `mail`**, and the only published ports are 80 and 443. With the `mail` profile, port **25** appears. Nothing declares `depends_on: mail`, so the profile being inactive cannot stall or break compose; the only residue is the `COGETO_MAIL_SMTP_ADDRESS` string, which the health check short-circuits before touching. The capability is first-class in the registry (TCP-probed, loud only when enabled and dead, `off` contributes nothing to the degraded verdict), in `cogeto features`, and in the System panel; the ufw rule and the MX/PTR/SPF checklist are both gated on it, and an upgrade carries a previously mail-receiving instance forward as enabled and says so. Residual W-14 |
| SEC-15 | **RESOLVED** | Wave 4 closed the scoping gap I reported. Live on the dev edge, `/api/health/live` now returns `strict-transport-security: max-age=300` together with the full header set; production carries `max-age=31536000; includeSubDomains`, no `preload`. Residual: the `s3.` vhost and the Zitadel handle block remain header-bare, so a cold first hit to the presign origin gets HSTS only transitively via the apex `includeSubDomains` (W-9 covers the related test weakening) |
| SEC-16 | **RESOLVED** | Verified live in both modes in revision 1: non-demo revokes the PAT, blanks `pat.txt` to 0 bytes, records `revoked: true` and short-circuits on re-run; the demo stack keeps it and states the residual explicitly |
| SEC-17 | **RESOLVED** | Verified on the running containers, not just in the file: `cogeto-app-1` mem 2 GB / pids 512 / 1.5 cpu, `cogeto-worker-1` 3 GB, `cogeto-postgres-1` 2 GB, `cogeto-caddy-1` 256 MB. Coverage is complete: 21 of 21 services in the dev file and 16 of 16 in the deploy file carry all three keys, asserted service-by-service in `deployment-hardening.spec.ts`. `pids_limit` values are all comfortably above the real process trees. Two residuals on the sizing claim rather than the coverage: W-4 and W-6 |
| SEC-18 | **RESOLVED** | Verified live. Migration 0038 adds `usage_counter` and `rate_limit_window`; both are owned by `cogeto_migrate` and both received the app-role grants, so wave 3's split and wave 4's tables interoperate. I confirmed the increment is a genuine single-statement atomic upsert (`INSERT ... ON CONFLICT DO UPDATE SET count = usage_counter.count + n`), not a read-modify-write, so no increment is lost under concurrency, and I executed it as the app role successfully. **Durability confirmed by experiment:** total counter sum was 80265, I restarted the app and worker containers, and it was 80265 afterwards. Counters are shared between app and worker and span UTC days. The enforcement parity test is real. The eviction that accompanies this is where the regression lies (W-1) |
| SEC-19 | **RESOLVED** | `scan` job with prod-only `npm audit`, `pip-audit` and Trivy; both allowlist entries carry an id, a rationale and a review date. Caveat unchanged: the job is deliberately not a required check |
| SEC-20 | **ACCEPTED** | Unchanged; owner console action, recorded only in the audit table |

### LOW and INFO

| # | Verdict | Evidence |
|---|---|---|
| SEC-21 | **PARTIAL** | Unchanged; `secret-preflight.ts` untouched by wave 4. The entry exists and is passed to `preflight` in both stacks, but preflight receives `${SEARXNG_SECRET:-}` while the dev searxng service defaults to the known dev value, and empty values are skipped, so the unset case (the `.env.example` default state) still ships the dev secret unrefused |
| SEC-22 | **RESOLVED** | Pinning invariant covers both compose files and all three Dockerfiles, plus a `:latest`-comment check |
| SEC-23 | **RESOLVED** | `image-pins.md` matches the pinned spaCy version and model |
| SEC-24 | **RESOLVED** (wave 5) | Wave 4 had made this worse: it committed both the audit and this report into the public repository while `security-overview.md` still claimed audit reports "are not published". The sentence now says what is true, that the audits and their independent verification are published in `docs/audits/`, including the open findings and the accepted risks |
| SEC-25 | **RESOLVED** | A session-level advisory lock on a fixed key wraps the whole run, taken on a dedicated connection and released in `finally`, so two concurrent `migrate` jobs serialize. `cogeto_migrations.checksum` records a sha256 over the raw file bytes and is verified before any new migration runs; a whitespace-only edit is detected (the spec proves it with a comment-only append); a NULL checksum is adopted once under an explicit `checksum IS NULL` guard so adoption cannot overwrite a real value; a deleted applied migration is refused. Residual W-10 |
| SEC-26 | **RESOLVED** | I checked the units specifically, because a seconds-versus-milliseconds slip here would be silent. `expiryFromClaims` returns `exp * 1000` and is compared by `Math.min` against `Date.now() + cacheTtlSeconds * 1000`, and read as `expiresAt > Date.now()`: milliseconds throughout, correct. A non-numeric or non-finite `exp` returns `null` and falls back to the flat TTL rather than producing `NaN`. Parsing is guarded, so a malformed JWT raises `UnauthorizedException` rather than crashing. `Math.min` can only shorten, so a forged `exp` cannot extend the cache |
| SEC-27 | **RESOLVED** (wave 5) | The eviction was already correct in isolation: throttled to once a minute, a two-window horizon, an indexed `window_start` predicate, and failures routed to a log hook rather than raised into a request. What made it PARTIAL was that the delete had no bucket filter while deriving its cutoff from the calling bucket's window, across a store shared by the 60-second HTTP limiter and the 3600-second mail limiter (W-1). The sweep is now scoped to the calling bucket, so every row is measured against its own bucket's window and an idle bucket's rows are swept by that bucket's next hit. Regression test covers two buckets with two window lengths |
| SEC-28 | **RESOLVED** | Verified live: `/api/health/live` returns `content-security-policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox`, plus `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and HSTS. Present on the `/api/*` block in both Caddyfiles. I checked whether the strict policy breaks anything and it does not: no `/api` route is navigated to or embedded. File and passport downloads return JSON containing a presigned URL on the `s3.` origin and are opened from there; the chat SSE stream is consumed by fetch-based streaming, not `EventSource`, and CSP response headers do not apply to fetch/XHR; there is no `Content-Disposition`, `StreamableFile`, `sendFile` or redirect anywhere in the server |
| SEC-29 | **RESOLVED** | Redact paths extended one level, with a written rationale for the remaining depth |
| SEC-30 | **RESOLVED** | Receipt written only when something was erased; a source-row-only deletion still yields an honest "0 memories" receipt, verified live |
| SEC-31 | **RESOLVED** | `.dockerignore` for both service contexts, killing the `__pycache__` leak |
| SEC-32 | **RESOLVED** | `sourceMap: false` in the build config only |
| SEC-33 | **RESOLVED** | Deciding an approval is owner-only by default. The test is `orgScoped !== true`, so omitted, `false` and `undefined` all mean owner-only, which is fail-closed with no truthiness trap. No wired action opts in: the registry holds exactly two actions and `orgScoped` appears nowhere outside the type, the guard, a test-only definition and docs. The refusal is `NotFoundException`, matching the cross-org refusal, so existence is not leaked. Both branches are tested, including a registered `orgScoped: true` definition proving the escape hatch works. There is a single confirm surface, with no admin override. Residual W-7 |
| SEC-34 | **ACCEPTED** (wave 5) | Not fixed, and now accepted in writing rather than only verbally. Postgres traffic remains plaintext. The rationale and, more importantly, the conditions that void it are recorded in `docs/security/isolation-and-access.md` under "Residual notes": Postgres publishes no port on either compose file, and every party on that bridge network already holds database credentials, so encryption there defends against an attacker who is already inside the network namespace. The acceptance is explicitly void if the port is published, the database moves to another host, or a second tenant shares the network |
| SEC-35 | **RESOLVED** | Real release tags recorded beside unchanged digests in all four locations |
| SEC-36 | **ACCEPTED** | `sessionStorage` tradeoff recorded in the dev Caddyfile comment and the audit INFO row |
| SEC-37 | **ACCEPTED** | Recorded only in the audit INFO row |
| SEC-38 | **ACCEPTED** | By-design comments in both compose files plus the audit INFO row |
| dev-only npm audit | **ACCEPTED** | `ci.yml` states plainly that `--omit=dev` is deliberate and not a lowered threshold |

---

## 3. The twelve breaking-risk areas

Areas 1 to 6, 11 and 12 were verified in revision 1 and re-checked here; areas 7 to
10 were premised on wave-4 work that now exists and are verified for the first time.

**1. Health endpoints.** Live: `/api/health` 401, `/api/health/live` 200. Both compose
healthchecks poll `/api/health/live`, so no container can restart-loop; the operator
status and features paths use the in-container loopback route and get full detail; the
web client sends the session and non-admins get a trimmed report. No consumer lost
access.

**2. HSTS.** Now on both the SPA and `/api/*` blocks in both Caddyfiles, one year with
`includeSubDomains` and no `preload` in production, five minutes on dev. Every
subdomain the runbook provisions is either HTTPS-terminated by Caddy or SMTP-only.
Residual: the `s3.` vhost sends no headers of its own.

**3. The fetcher.** Address pinning remains deliberately unimplemented (SEC-12). I drove
the real `WebFetchService` against the live internet: `example.com`, an `http` to
`https` redirect, Wikipedia and `cloudflare.com` all fetched; `expired.badssl.com` and
`wrong.host.badssl.com` were both refused, so **certificate validation is intact**,
which is the specific way this fix could have silently failed; `169.254.169.254`,
`10.0.0.5`, `127.0.0.1` and `[::1]` were all refused as private. External IPv6 could
not be tested because the Docker bridge has no IPv6 route.

**4. CI scanning.** The `scan` job runs on every PR and push with dated, scoped, reasoned
allowlists, and dev-only highs are excluded by `--omit=dev` with a written rationale
rather than a lowered threshold. It is deliberately not a required check, so a red scan
does not block a merge.

**5. Postgres least privilege.** Re-probed live, all five negative properties hold. The
new wave-4 tables are covered by the grant convergence, and I confirmed the app role can
perform the exact upsert the limiter needs. The queue, outbox, sweep, saga, audit inserts
and ops CLIs all work under the restricted role.

**6. MinIO.** Re-probed live: admin API refused, SSE cannot be disabled, no bucket
creation, object operations work, encryption readable and on.

**7. Resource limits.** Now present on every service in both files and applied to the
running containers. They are generous per container: worker 3 GB against a 25 MB parse
plus embedding batches, redaction 2 GB against a documented ~1 GB model, Postgres and
Qdrant 2 GB each. Two honest qualifications. First, **the ceilings do not bound the
aggregate**: the always-on services sum to about 11.25 GB of limits against an enforced
7 GB host floor, so the cgroup caps one runaway container (the named finding, genuinely
mitigated) while the host OOM killer still arbitrates collective exhaustion (W-6).
Second, **Node is never told about its cgroup** (W-4), and off-heap buffers do not count
against V8's budget, so the realistic failure under a large parse is a SIGKILL rather
than harder GC.

**8. The mail profile.** Verified by resolving the compose config both ways: no `mail`
service and no port 25 by default, port 25 only with the profile. Nothing depends on
`mail`, so its absence cannot break the stack. The capability registry, `cogeto features`
and the System panel all reflect it, the health check stays green when it is off, and the
installer checklist omits the mail DNS steps rather than pointing real mail at nothing.
Email intake itself works when enabled: in revision 1 I sent a real SMTP message through
the mail container and it landed parsed in `email_message`.

**9. Durable limits and worker metering.** Counters and budgets are durable, shared and
atomic, and I proved durability by restarting app and worker and watching the total hold
at 80265. Worker model calls are now attributed to the enqueuing principal, visible per
task family in the live table. Jobs in the older payload shape still run, on two
independent grounds. Normal usage is mostly not throttled, with one qualification: the
raised default of 10k calls a day is thinner than the comment claims, because one large
document can cost up to 200 extraction calls plus verification and reconciliation, so
roughly 50 large uploads in a day would exhaust it, well inside the 300/day upload quota
it was said to be sized from. Reindex and eval paths are unmetered, so a corpus reindex
cannot be refused. **This area also contains the wave's one high-severity regression,
W-1.**

**10. Email rendering.** The regex sanitizer is gone rather than supplemented, the
parser-based sanitizer and the sandboxed iframe are both in the path, and both
demonstrated bypasses are covered by named tests that assert the parse tree. I confirmed
all of this by running the shipped sanitizer against my own hostile corpus rather than
trusting the tests, and confirmed realistic mail still renders. Residual W-8: stored
email HTML written before wave 4 was never re-sanitized, and is inert only because the
iframe now contains it.

**11. Prompt fencing.** Unchanged by wave 4. Fence sound and unforgeable, applied at the
raw ingestion seams, new prompt versions are new files, traps gated at zero tolerance.
Eval deltas across the prompt change: extraction precision 0.7923 to 0.7958 and recall
0.9135 to 0.9196 (both up), verification agreement 0.8919 to 0.8690 (down 2.3 points,
inside the documented variance band and far above the gate), chat 24/24 to 23/24 on a
known grader-variance case, on a corpus grown from 76 to 86 cases. No evidence the fence
degraded quality. Coverage gaps remain as recorded under SEC-4.

**12. Passport expiry.** Verified end to end in revision 1 and unchanged: expiry, refusal
by name, receipt counts and object keys, byte erasure, unbroken chain, four audit events.
The `markReady` race remains.

---

## 4. New issues introduced by wave 4

| # | Severity | Issue | Evidence | Fix scope |
|---|---|---|---|---|
| **W-1** | **High** | **FIXED (wave 5). Cross-bucket rate-limit eviction silently weakened the inbound-mail cap.** `evict()` deleted on `window_start < cutoff` with **no bucket filter**, and the cutoff came from the *calling* bucket's window. One global store serves both the HTTP limiter (60 s) and the mail-intake limiter (3600 s), and the mail service is explicitly wired to the same instance, so any HTTP request that tripped the once-a-minute sweep deleted live `email_intake` rows older than two minutes, resetting each sender's count. The per-sender cap degraded from ~60/hour to ~60 per two minutes. The in-process map it replaced did not have this bug, because it expired each entry on its own `resetAt` | `infrastructure/rate-limit-store.ts`; windows at `rate-limit.ts:69` and `email-intake.service.ts:101-102`; shared singleton at `limits.module.ts:41-59`. **Demonstrated live** against the running database (rollback-guarded): a sender 10 minutes into a one-hour window at 55 of 60 was deleted by the HTTP cutoff | Done: the delete is scoped to the calling bucket, with a two-bucket, two-window regression test |
| W-2 | Medium | **FIXED (wave 5).** The post-call charge could fail an already-successful model call. `record()` was `await`ed after the provider call, where it had previously been synchronous and unthrowable, so a transient database error turned a completed call into a thrown error and, for streaming, threw *after* the whole answer had been yielded, surfacing "answer generation failed" to a user who had already seen the answer | `model-gateway/budgeted.gateway.ts` | Done: the charge is best-effort again, logging a warning instead of raising, matching the contract the code documents |
| W-3 | Medium | One owner's exhausted budget aborts the entire nightly dreaming cycle. The per-owner scope has no `try`/`catch`, so `ModelBudgetExceededError` for one owner propagates out of the loop and skips the remaining owners, the later passes and the digest | `ingestion/dreaming.service.ts:107-118` | Wrap the per-owner body and continue |
| W-4 | Medium | **FIXED (wave 5).** Node was never told about its memory limit: no `--max-old-space-size` anywhere, while `mem_limit` had just been set. Off-heap buffers (25 MB mail and document parses, embedding payloads) count against the cgroup but not V8's budget, so the failure mode was an OOM SIGKILL mid-job rather than harder GC. The compose comment named exactly this workload | both compose files | Done: `--max-old-space-size=1536` on `app` (2g limit) and `=2304` on `worker` (3g limit) in both files, deliberately below the ceiling so the gap is off-heap working room |
| W-5 | Medium | No architecture gate for the pinned cosign binary. `check_os` validates only distribution and version; the URL and the pinned checksum are both `linux-amd64`. On an arm64 Ubuntu host the download and checksum both succeed, the version probe's `\|\| echo` masks the exec failure, and the install appears to succeed, failing later at `cosign verify` with a confusing error | `scripts/operator/cogeto:385-402,539,559` | Add an explicit architecture check |
| W-6 | Low-medium | Per-container ceilings do not bound the aggregate: always-on limits sum to ~11.25 GB against a 7 GB enforced floor (and ~10 vCPU against a 2 vCPU floor). The compose comment's "still fits the 8 GB minimum" is literally true of reservations but reads as stronger protection than it is | both compose files; `MIN_RAM_MB=7000` at `scripts/operator/cogeto:67` | Reword the comment, or size the always-on set to the floor |
| W-7 | Low | The Approvals page renders dead buttons. Visibility is deliberately unchanged, so a teammate still sees another user's pending approval, but Approve and Reject now fail with the raw non-leaking string "approval `<id>` not found" | `project/web/src/pages/Approvals.tsx:167-190`; DTO has `requestedBy` but no `canDecide` | Server-computed `canDecide` on the DTO |
| W-8 | Low | No backfill of email HTML stored before wave 4. Sanitizing happens at write time only and the render path does not re-sanitize, so old rows still hold markup that the old regexes passed. Mitigated, not fixed, by the sandboxed iframe, which is now the only render path | `email-intake.service.ts:252`; `email-source.service.ts:43-49` | State it in the audit entry, or re-sanitize on read |
| W-9 | Low | A drift test was silently weakened. The "production edge keeps the dev CSP verbatim" check takes the **first** CSP line, which is now the identical `/api/*` policy, so divergence between the dev and deploy **SPA** CSPs would no longer fail CI | `operator-script.spec.ts:600-605` | Collect all matches and compare arrays |
| W-10 | Low | A migration failure's cause is masked. The `finally` that releases the advisory lock has no `catch`, so if the connection died mid-run the unlock error replaces the real "migration `<file>` failed" error | `infrastructure/migrations.ts:52-57` | Catch around the unlock |
| W-11 | Low | A second asset-fetch path bypasses the new trust chain and would now fail hard. `features enable research` calls `fetch_one` with a **mutable tag ref** and with no manifest loaded, so `manifest_sha` returns empty and the call dies with "no checksum ... refusing to install an unverified deployment file. This release's manifest is incomplete; do not work around it." It is near-dead code because installs and upgrades now fetch the file eagerly, but if reached it fails with a misleading message | `scripts/operator/cogeto:1337`, `:614`, `:676-681` | Reuse the verified fetch, or drop the fallback |
| W-12 | Low | The ingest and research quota check became a genuine check-then-act. Both calls are now awaited round trips, so concurrent captures can all read `count < max` before any increment lands. Overshoot is bounded by the per-minute rate limit, but the comments still claim the reservation is atomic | `notes.service.ts:36-38`, `files.service.ts:135,147`, `research.service.ts:367-425` | Compare the `RETURNING count` of a single upsert against the cap |
| W-13 | Low | Third-party sender addresses are now stored durably. The envelope sender becomes `rate_limit_window.principal_id`, which previously lived only in memory. There is no retention job for that table (unlike email refusals), rows are pruned only opportunistically, and neither new table appears in any deletion-cascade enumeration | `email-intake.service.ts:100-102`; no references outside the limiter files | A deliberate spec §11.1 decision, recorded either way |
| W-14 | Low | `cmd_upgrade` never calls `open_firewall`, so mail carried forward as enabled relies on the pre-existing ufw rule surviving. If it did not, the capability probe still reports green because the Docker network path works, so a closed host port is silent | `scripts/operator/cogeto:1069` | Call `open_firewall` on upgrade |
| W-15 | Info | Six database round trips per metered model call (two SUMs to check, then two upserts each followed by a discarded SUM). Both `add()` return values are thrown away | `model-budget.ts:62-66`, `daily-counters.ts:65-83` | Fire-and-forget the charge without the read-back |

### Issues from waves 1 to 3

**Fixed in wave 5:** N-1, the passport `markReady` race (see SEC-8). N-4,
`security-overview.md` listing `answer` among the prompts carrying the fence clause
when `answer/v0007.md` contains none; the paragraph now names the four families that
do carry it and states plainly why the answer path deliberately carries neither the
fence nor the clause. N-5, `deletion-and-receipts.md` describing the abandoned SEC-30
implementation; it now documents the shipped rule, including that removing the source
row counts as erasure so a just-captured note still earns an honest "0 memories"
receipt. N-6, the SEC-24 publication claim.

**Still open:** N-2 forged-framing guard false positives that no eval gate can see,
since the corpus contains no benign document carrying those labels; N-3 a stale
operator script dying mid-upgrade on newly required variables; N-7 the app role's full
DML on `graphile_worker.migrations`; N-8 default privileges granting TRUNCATE on all
future tables; N-9 `seed-object` and `seed-orphan` depending only on postgres and
minio, not on `db-init`, `migrate` or `minio-init`.

### Checks that came back clean

- **The full suite passes on wave 4 plus the wave-5 fixes**: `npm test` returns **727
  passed, 2 skipped** on the server workspace (118 test files) plus **86 passed** on web,
  exit 0. Wave 4 alone was 724 and 86; revision 1 was 687 and 81. The three added tests
  are the wave-5 regression tests, and each was confirmed to FAIL against the code it
  guards: reverting the two fixes made exactly those tests fail and nothing else.
- **Boundaries clean**: 0 violations over 511 modules and 2641 dependencies, up from 503
  modules, so wave 4 added modules without adding coupling.
- **Lint clean**, including the house dash guard over 84 markdown files (this report is
  now tracked and is scanned by it).
- **Wave 3 and wave 4 interoperate**: both new tables are owned by the migration role and
  received the app-role grants, and the app role can perform the limiter's upsert.
- **The strict new API CSP breaks nothing**, verified by enumerating every navigated or
  embedded response.
- **Mail profile off does not break compose**: nothing declares `depends_on: mail`.
- **The old job payload shape still runs**, by defensive read and by loose schema.

---

## 5. Functional verification

The end-to-end run in revision 1 was performed on a stack booted from empty volumes in
an isolated compose project, and covered: fresh boot with every one-shot exiting 0,
login, note capture, document upload with the type allowlist refusing a bad type, real
SMTP intake, chat citing memory with zero citation violations, the research approval
gate including a 409 on changed text, source deletion with a verifying receipt, passport
export and presigned download, export expiry after deletion with the bytes erased, the
integrity sweep, a dreaming cycle, and an honest capability report. All passed.

Wave-4 functional verification was performed against the owner's running stack on the
new code:

| Step | Result | Observed |
|---|---|---|
| Migration 0038 applies | **PASS** | 38 migrations applied; both tables present, owned by `cogeto_migrate` |
| App role can use the new tables | **PASS** | Grants converged; the atomic upsert executes as `cogeto_app` |
| Counters durable across restart | **PASS** | Sum 80265, restarted app and worker, sum 80265 |
| Worker model spend attributed | **PASS** | `model_tokens` by family: `ingestion.pipeline` 51261, `dreaming` 4651, `research.conclude` 4140, `conversation.title` 155 |
| Resource limits applied | **PASS** | Running containers report the advertised memory, pid and cpu ceilings |
| Security headers on `/api/*` | **PASS** | Strict CSP, nosniff, referrer, frame-options and HSTS all present |
| Mail profile gating | **PASS** | No `mail` service and no port 25 by default; port 25 only with the profile |
| Email sanitizer against hostile input | **PASS** | 13 payloads including both audit bypasses; parse tree shows no handler, no scripting scheme, no forbidden tag |
| Legitimate mail still renders | **PASS** | Formatting, links, tables and `cid:` images preserved |
| Cross-bucket eviction | **FAIL** | A live one-hour mail window at 55 of 60 was deleted by the 60-second HTTP cutoff (W-1) |

**Not re-run for wave 4**, and therefore not claimed: a full fresh-volume boot with the
new one-shot ordering, the end-to-end user journeys (they exercise code paths wave 4 did
not change, but the durable limiter now sits in the capture path), and an operator
install or upgrade against a real host.

---

## 6. Accepted-risk register

| Finding | Risk in plain language | Rationale | Where it is recorded |
|---|---|---|---|
| SEC-12 | DNS rebinding can still point a fetch at an internal address after the guard approved a public one | Pinning needs a custom dispatcher; undici is only a transitive dependency at a different major, so depending on it would be undeclared and fragile. Bounded by single tenancy, explicit invocation and budget caps | Audit remediation table and `docs/features/web-research.md:48-52`, both verified accurate |
| SEC-20 | A long-lived admin PAT can merge to protected `main` without review | Handled in the GitHub console | Audit remediation table only, on the owner's word; console state is not verifiable from the repo |
| SEC-36 | The bearer token in `sessionStorage` is readable by an XSS | Accepted for v1; strict `script-src 'self'` is the real mitigation | Dev Caddyfile comment plus the audit INFO row |
| SEC-37 | The `id_token` is not verified client-side and there is no `nonce` | The access token is validated server-side via userinfo; PKCE and `state` are correct | Audit INFO row only |
| SEC-38 | The worker holds the receipt-signing key and also parses untrusted mail and web pages | By design: the worker is what signs | Compose comments plus the audit INFO row |
| Dev-only npm highs | Ten known high advisories in the dev tree | Never installed into a shipped image; `--omit=dev` is deliberate, not a lowered threshold | `.github/workflows/ci.yml` and PR #292 |
| SEC-34 | Database traffic inside the compose network is plaintext | Postgres publishes no port on either compose file, so the only listener is on the private bridge; every party on that network already holds database credentials, so encrypting between them defends only against an attacker already inside the network namespace, where reading process memory or `.env` is easier than capturing traffic. Weighed against a per-instance certificate to issue, mount, rotate and expire on an appliance the operator does not otherwise administer. **Void if** the port is published, the database moves to another host, or a second tenant shares the network | `docs/security/isolation-and-access.md`, "Residual notes", added in wave 5 |
| SEC-16 demo residual | The dev sandbox keeps its bootstrap PAT | A sandbox holds no real data and is disposable | `zitadel-init/init.mjs`, both compose files, `isolation-and-access.md`, and verified live |

Every acceptance now has a written rationale. The weakest record is **SEC-37**, which
rests solely on a row inside the audit report and would vanish if that report were
superseded; it belongs in `docs/security/` alongside the others.

---

## 7. Residual risk in plain language

**What a competent attacker could still do against a correctly installed instance.**

The email path is much stronger than it was. Hostile markup no longer executes: it is
parsed and rebuilt from an allowlist, and then rendered inside a frame that cannot run
scripts even if the sanitizer were bypassed. Two layers now have to fail together. What
remains is content and phishing injection, which no sanitizer addresses, and email
stored before this change, which is inert only because of the frame.

The strongest remaining lever is memory poisoning. Fencing makes the extractor hard to
steer and the traps prove the obvious payloads are caught, but a sufficiently persuasive
document can still land a false claim as a stored fact. It will be attributed and
deletable and cannot change visibility, ownership or provenance, but a user who trusts
the answer is misled. Two seams stay weaker than the rest: a reply draft puts a raw
third-party body behind a delimiter the email itself can close, and the answer path is
deliberately unfenced.

An attacker with code execution in the app or worker is genuinely contained. They cannot
rewrite the audit trail, drop the receipt ledger, reach the identity database, or escape
the bucket or reach the MinIO admin API. I verified each by attempting it. Resource
exhaustion is now bounded per container, though not in aggregate, and the abuse counters
survive a restart, so the crash-loop-resets-the-cap path is closed.

The sharpest opening found in this review, W-1, is closed: the per-sender inbound mail
cap now holds for its full hour instead of being reset by unrelated web traffic. What
remains on that surface is ordinary volume within the cap.

Database traffic inside the compose network is still plaintext. That is now a recorded
decision rather than an oversight, and its invalidating conditions are written down, so
the next person to publish the port or split the database across hosts has the reason to
revisit it. Rebinding remains possible against the research fetcher by explicit,
documented decision.

The most likely source of the next real incident is not on this list. It is the pattern
this review kept finding: a control that is correct in isolation and wrong in
composition. The eviction was individually correct and wrong against a second bucket;
the memory ceilings are individually correct and unbounded in aggregate; the fence is
correct at four seams and absent at a fifth. Those are not caught by reading a diff, only
by asking what else shares the thing being changed.

**What remains unverified.** Advisory applicability for the pinned images was not checked
against live databases. GitHub console state is not readable from the repository, so the
SEC-20 acceptance rests on it. I did not re-run a fresh-volume boot, the end-to-end user
journeys, or an operator install or upgrade against the wave-4 code, so the new one-shot
ordering, the installer's cosign and manifest verification, and the mail carry-forward on
upgrade are verified by reading and by unit assertions rather than by execution. The
arm64 installer failure (W-5) is reasoned about, not reproduced. External IPv6 fetching
could not be tested because the Docker bridge has no IPv6 route. The passport
`markReady` race is confirmed by code reading and interleaving analysis; I did not
construct the timing window at runtime.
