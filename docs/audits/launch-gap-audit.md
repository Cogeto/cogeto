# Cogeto — Launch Implementation-Gap Audit (O7 re-run)

**Date:** 2026-07-16 · **Repo:** `Cogeto/cogeto` @ `fb06d02` · **Method:** read-only
re-run of the implementation-gap audit per the method, categories, evidence rules, and
severity taxonomy of `docs/audits/implementation-gap-audit.md` (2026-07-04), now assessed
against the **v1 definition of done** in `docs/Cogeto-v1-Roadmap-Revision.md` (BINDING).
Everything shipped since the last gap audit is in scope: email/Haraka (O4) and the sender
allowlist (decision 0031), reply drafting with forwarded-message addressing, the
time-travel diff UI (O5), the Memory Passport (O5), the operator script and runbook (O6),
and the trust-scores release artifact (O7). Every claim carries a `file:line` or grep
result. No files were modified except this report and its siblings.

## Method & severity taxonomy (unchanged from the source audit)

Categories: (1) placeholders/stubs, (2) built-but-unused, (3) promised-but-unimplemented,
(4) test & eval coverage gaps, (5) hygiene. Severity is judged **against launch** (the v1
DoD), not against a future roadmap: `CRITICAL` = launch cannot proceed / data-loss or
false-claim risk; `HIGH` = a binding v1 requirement is unmet or an internet-facing gap;
`MEDIUM` = a required behaviour is partial or a stated mechanism is inert; `LOW` = drift
or narrow gap; `INFO` = calibration/no action.

## Executive summary

The v1 build is **substantially complete and honestly delivered**: the original audit's
three blocking stubs (deletion saga, approval machine, reconcile) and all eleven
Verifiable-Memory features are now real, and the four remaining v1 sessions landed with
strong invariant tests. The email vertical (O4) is 12 of 14 requirement rows fully
implemented — transactional intake, sender routing, thread-aware extraction, an honest
single-receipt deletion cascade over email rows/attachments/objects, reply drafts that
**cannot send by construction**, and en/hr golden cases. Time-travel (O5), the Memory
Passport (O5), the operator script + runbook (O6), and the immutable trust-scores artifact
(O7) all meet their Roadmap rows with evidence. **What blocks a clean launch gate is a
small, sharply-defined set:** two gaps on the **internet-facing SMTP surface itself** —
Haraka's committed rate/concurrency limits are **inert** (the plugin needs per-section
`enabled=true` and a Redis backend that no compose stack provides) and there is **no
inbound STARTTLS** on the launch path, so forwarded mail (the core capture flow) crosses
the internet in cleartext; one **explicitly-required parser silently dropped** without a
deferral record (calendar-invite parts *within* emails, the exact mechanism D1 leans on to
justify dropping the calendar connector); the **trust-score public page and compliance
one-pager are not in this repo** (website deliverables — DoD bullet 5 unmet on repo
evidence); and the golden corpus sits **below the spec's launch size** (en 49, hr 35 vs
50/language). Everything else is drift or narrow hardening. **The DoD requires both audits
to pass, so the HIGH items and the two owner-only launch deliverables must be resolved or
ruled before v1.0.0.**

**Counts by severity: CRITICAL 0 · HIGH 4 · MEDIUM 6 · LOW 4 · INFO 4.**

---

## Prior-audit closure (the 2026-07-04 gaps)

The original gap audit's blockers were all "expected gaps" for later sessions. Re-verified
as **closed**:

| Original gap | Then | Now | Evidence |
|---|---|---|---|
| Deletion saga + receipts | stub threw | DONE | `memory/deletion-saga.ts` (enumerate→pending receipt→confirm w/ hash+signature) |
| Approval state machine | empty `@Module({})` | DONE | `agents/approvals.controller.ts`, `agents/actions/*`, `approval.service.ts` |
| Reconcile stage 6 | pass-through stub | DONE | reconciliation w/ contradiction/merge; `contradicted` reachable |
| Temporal retrieval / time-travel | schema only | DONE (O5) | `memory/timeline.controller.ts`, `TimelineView.tsx` |
| Files + object storage | never touched | DONE | `connectors/files.controller.ts`, MinIO SSE asserted at boot |
| Chat capture, shared scope, tasks | shells | DONE | `chat.controller.ts:52 /remember`, tasks engine, shared scope writers |
| Redaction mode (§B.8) | absent | DONE | Presidio sidecar + `RedactingModelGateway`, fail-closed |
| Ana sandbox | placeholder | DONE | password-gated demo seed (decision 0027) |
| Golden-set CI gate | off | DONE | live gate on push to main (`ci.yml:112-163`) |

All 41 findings of the 2026-07-10 quality/security audit are also marked RESOLVED in that
document; the O7 security re-run is the sibling `launch-security-audit.md`.

---

## Module / surface state table (new surfaces since last audit)

| Surface | State | Evidence |
|---|---|---|
| **email intake** (O4) | FUNCTIONAL | `connectors/email-intake.service.ts` (mailparser, transactional object-first, sender routing); `0021_email_inbound.sql` |
| **Haraka mail service** | FUNCTIONAL (receive-only) **/ config gaps** | `project/services/mail/` — receive-only real; **limits inert, no STARTTLS** (F1, F2) |
| **sender allowlist** (0031) | FUNCTIONAL | `connectors/email-allowlist.service.ts`; routing + normalization + claim UI |
| **reply drafting** | FUNCTIONAL (non-sending) | `email-reply-draft.service.ts`, `agents/actions/email-reply-draft.action.ts:73-82` |
| **time-travel diff UI** (O5) | FUNCTIONAL | `memory/timeline.controller.ts`, `web/src/components/TimelineView.tsx` (500 lines, 3 modes) |
| **Memory Passport** (O5) | FUNCTIONAL | `passport/passport.controller.ts`, `passport-export.executor.ts`, `docs/passport-schema/` |
| **operator script** (O6) | FUNCTIONAL | `scripts/operator/cogeto` (995 lines; install/configure/upgrade/status/backup-info/--check) |
| **operator runbook** (O6) | FUNCTIONAL | `docs/operator-runbook.md` (403 lines; onboarding→backup→rehearsed restore→upgrade) |
| **trust-scores artifact** (O7) | FUNCTIONAL | `entrypoints/trust-scores.ts`, `scripts/ci/publish-trust-scores.mjs`, `eval/trust-scores/*` |
| **calendar-invite parsing** | **ABSENT** | no `text/calendar`/VEVENT handling anywhere (F3) |
| **trust-score public page / compliance one-pager** | **ABSENT (external repo)** | DoD bullet 5 — not in this repo (F4) |

---

## Findings (ordered by severity)

### HIGH

**GAP-1 — HIGH — Haraka rate/concurrency limits are inert (committed config does
nothing).** *(built-but-unused / promised-but-unimplemented.)* `project/services/mail/haraka/config/plugins`
loads `limit`, and `config/limit.ini` sets `[concurrency] default=3`, `[rate_conn]
default=30/60s`, `[rate_rcpt_host] default=30/60s` — the exact knobs decision 0028 ruling 6
commits to (`docs/decisions/0028-inbound-email-design.md:149-156`). But the bundled
haraka-plugin-limit registers **no hooks unless each section sets `enabled=true`** (the
repo sets it nowhere), the concurrency block uses key `default=` where the plugin reads
`max=`, and the rate counters require a **Redis backend** that neither compose stack
provides (`docker-compose.yml`, `docker-compose.deploy.yml` have no redis). No app-side
compensating limit exists — the intake route has no `@RateLimit`
(`email-intake.controller.ts:29-37`) and the FIX-2 limiter is per-authenticated-principal
anyway. **Risk:** every customer box exposes an internet-facing port-25 service with zero
connection/rate limiting; any host can hammer it (amplified by GAP-6). **Remedy:** enable
+ correct the limit.ini sections and provide the backend they need (add a small
mail-scoped Redis, or implement an in-process connect-rate plugin), then rebuild
`cogeto-mail` — **automated** code change, owner ships via release.

**GAP-2 — HIGH — No inbound STARTTLS on the launch path.** *(promised-but-unimplemented.)*
`docs/notes/email-inbound.md:115-122` promises O6 provides STARTTLS; reality: no `tls`
plugin in `config/plugins`, no `tls.ini`, deploy compose maps `25:2525` raw
(`docker-compose.deploy.yml:397-399`), and `starttls` appears nowhere in
`scripts/operator/cogeto` or `docs/operator-runbook.md`. **Risk:** the server never
advertises STARTTLS, so every forwarded email — the product's core capture flow, and D2's
"email data never leaves the tenant's box" claim — crosses the internet in cleartext, and
strict/MTA-STS senders may refuse delivery. **Remedy:** mount the Caddy-obtained cert (or
a dedicated one) into the mail container, enable Haraka's `tls` plugin, wire it in the
operator script — **automated** code + O6-script change; the provisioning mechanism needs
**owner sign-off**.

**GAP-3 — HIGH — Trust-score public page + compliance one-pager absent (DoD bullet 5).**
*(promised-but-unimplemented.)* Both are v1-locked (Roadmap D5, line 24) and "live" is an
explicit DoD line (line 47). Nothing in this repo builds or ships either; the repo only
references them as website deliverables (`docs/trust-scores-schema/README.md:5`
"rendered by the public trust-score page on cogeto.eu";
`docs/Cogeto-Technical-Architecture.md:324,342`). The **data** side is ready
(`eval/trust-scores/index.json` + immutable per-version files), but there is no public
renderer and no one-pager. **Risk:** the O7 launch gate cannot pass on repo evidence
alone; the published trust data has no public face and the compliance one-pager
(data residency, encryption posture, sample receipt, subprocessors, GDPR/AI-Act mapping)
does not exist. **Remedy:** build the page (consuming `eval/trust-scores/index.json`) and
the one-pager in the **website repo** — **owner-only** (separate repo; real-data
publishing).

**GAP-4 — HIGH — Calendar-invite parts inside emails are not parsed (explicit O4
requirement, silently dropped).** *(promised-but-unimplemented.)* The O4 row requires
parsing "calendar-invite parts within emails"; greps over `project/src`,
`project/services/mail`, and `project/prompts` return **zero** `text/calendar`/ics/VEVENT
hits, and `ALLOWED_UPLOAD_CONTENT_TYPES` is pdf+docx only (`project/shared/src/files.ts:52-55`),
so an invite part is stored as an *unsupported* attachment and never parsed
(`email-intake.service.ts:182-199`, `0021_email_inbound.sql:56-60`). No decision record
defers it. **Risk:** the D1 rationale for dropping the calendar connector ("meeting
invites arrive as email and flow in for free", Roadmap line 12) is partially unbacked —
invite-only emails yield weak/empty extraction (`email.source-reader.ts:34-38` falls back
to the subject). **Remedy:** parse `text/calendar` parts (deterministic VEVENT→text
summary appended to the extraction input) — **automated**; *or* an **owner** decision
record explicitly deferring it, filed before the O7 gate closes.

### MEDIUM

**GAP-5 — MEDIUM — Intake endpoint is publicly routable, contradicting decision 0028
ruling 7 ("never public").** *(hygiene / attack surface.)* The deploy edge proxies all of
`/api/*` to the app (`project/infra/deploy/Caddyfile:32-34`), including `/api/email/intake`;
Express body parsing runs **before** Nest guards
(`app.use('/api/email/intake', raw({limit: config.mailMaxBytes}))`, `entrypoints/app.ts:39`),
buffering up to 25 MB per unauthenticated request. The guard itself is fail-closed
constant-time bearer (`mail-intake.guard.ts:20-36`). **Risk:** unauthenticated 25 MB body
buffering from the public internet, plus drift from the binding decision text ("internal
network only — never public", `0028:169-171`). **Remedy:** add a Caddy matcher refusing
`/api/email/intake` at the edge (the mail container calls `app:3000` directly, so nothing
breaks) — **automated**, one line in both Caddyfiles. *(This is the same surface as
security finding SEC-2; fix once.)*

**GAP-6 — MEDIUM — `email_refusal` is unbounded and attacker-writable.** *(hygiene;
compounds GAP-1.)* The public address scheme means every message to `capture@in.<domain>`
from an unknown sender inserts a refusal row (`email-intake.service.ts:319-339` →
`email-allowlist.service.ts:154-169`); no pruning exists (grep for `email_refusal` outside
the service/spec/tables is empty; the sweep has no refusal arm). **Risk:** with SMTP rate
limiting inert (GAP-1), a hostile host grows the table/disk without bound on a customer
box; also a slow PII accumulation of third-party addresses. **Remedy:** add a retention
cap (delete >30 days / keep newest N) as a sweep arm or on-insert trim — **automated**.

**GAP-7 — MEDIUM — Golden corpus below the launch target.** *(test/eval coverage.)*
`project/eval/golden`: en = 49 cases, hr = 35 cases; `docs/eval-golden-set.md:11` requires
"50 to 100 labeled items per supported language at launch." hr is 15 short (and thin for
reconciliation/contradiction coverage), en one short. **Risk:** the published trust score's
per-language claims rest on a corpus the spec itself calls sub-launch-size. **Remedy:** add
~15 hr + 1 en cases (synthetic/anonymized per corpus rules) — **automatable** (generation
+ owner label review).

**GAP-8 — MEDIUM — No test exercises the intake HTTP auth path.** *(test coverage.)*
`MailIntakeGuard` has no spec, and grep `email/intake` across `*.spec.ts` returns nothing;
all intake integration tests call `EmailIntakeService.intake()` directly
(`email-intake.integration.spec.ts:150+`). **Risk:** a wiring regression on the one
endpoint that is both `@Public()` and internet-reachable (GAP-5) — e.g. the guard dropped
from `@UseGuards` — would silently expose unauthenticated intake with no failing check.
**Remedy:** a guard unit test (empty/bad/good token) + one controller-level e2e —
**automated**.

**GAP-9 — MEDIUM — Passport docs schemas are not machine-checked against the emitter.**
*(test coverage / doc-drift.)* `passport_schema_valid` validates generated documents
against the in-code Zod mirror only (`passport-assembler.spec.ts:116-131`); nothing loads
`docs/passport-schema/*.schema.json`, despite `passport-format.ts:7-12` claiming "a drift
between the artifact and its documented format fails the build." Trust-scores has this
cross-check (`trust-scores.spec.ts:130-141`); Passport does not. **Risk:** silent drift
between the published open format and real archives — the exact failure the format promise
forbids. **Remedy:** add an ajv validation of generated documents against the four
published JSON Schemas — **automated**.

**GAP-10 — MEDIUM — Eval gate soft-skips when the live key is missing on main.**
*(test/eval coverage; CI.)* On push to `main` the eval-gate emits only a `::warning` and
passes the required check if `MISTRAL_API_KEY` is absent (`ci.yml:144-146`). **Risk:** a
deleted/rotated-out secret silently disables the launch-critical quality gate while `main`
stays green. **Remedy:** fail (or add a visible sibling required check) when the secret is
absent on push — **automated**. *(Overlaps platform finding PA-10; fix once.)*

### LOW

**GAP-11 — LOW — Mail env knobs absent from `.env.example`.** *(hygiene / env drift.)*
`.env.example:119-124` documents only `COGETO_ADMIN_USER_EMAIL`;
`COGETO_MAIL_INBOUND_ADDRESS`, `COGETO_MAIL_MAX_BYTES`, `COGETO_MAIL_ATTACHMENTS_MAX_BYTES`,
`COGETO_MAIL_INTAKE_TOKEN`, `COGETO_MAIL_HOST_PORT`, `COGETO_MAIL_SMTP_ADDRESS` are
consumed but undocumented (`docker-compose.yml:105-113,585-592`, `config.ts:203-208`).
**Remedy:** add commented entries — **automated**.

**GAP-12 — LOW — Refusal listing filters after the SQL LIMIT.** *(correctness, minor.)*
`email-allowlist.service.ts:172-186` fetches newest 20 rows globally then filters to
`ownerId === null || caller`, so other users' refusals can crowd a user's claimable rows
out of the window. **Remedy:** move the owner predicate into the `WHERE` before `LIMIT` —
**automated**. *(Same site as security finding SEC-6.)*

**GAP-13 — LOW — Chat gate is all-or-nothing on a live grader with known variance.**
*(test/eval coverage.)* "Chat eval gate (all cases must PASS)" (`ci.yml:159-163`) while
`atlas_scope` has documented coverage-grader variance (published honestly in v0.9.2 notes).
**Risk:** recurring flaky red on `main` → gate fatigue. **Remedy:** stabilize the grader or
add a documented retry-once for grader-variance cases — **automated**.

**GAP-14 — LOW — Stale gates note references the old corpus size.**
`project/eval/gates.json` note says thresholds were calibrated on "the 36-case corpus";
the corpus is now 84 cases, so the floors may sit needlessly low. **Remedy:** re-measure
variance and ratchet up + refresh the note (threshold change needs a decision record per
the note) — **automatable**.

### INFO

- **GAP-15 — INFO — Stale "Unit B" comments describe shipped features as pending.**
  `email-settings.controller.ts:32-34` ("forwarding-setup guidance … is Unit B" — shipped,
  `Settings.tsx:359-381`), `email.source-reader.ts:56-59` ("saga coverage … lands in
  Unit B" — shipped). Decision records are historical; the two code comments should be
  corrected — **automated**.
- **GAP-16 — INFO — Built-but-unused `host_list` mail config.** `docker-entrypoint.sh:14`
  writes `config/host_list`, read by no loaded plugin (recipient validation is
  `cogeto_rcpt.js`). Harmless; delete or comment — **automated**.
- **GAP-17 — INFO — Redelivery duplicates the retained copy** (accepted by decision 0031's
  "Redelivery note"): a mid-loop 451 retry stores a second `email_message` row + raw object;
  reconciliation dedups the *memories* but not the retained rows. No action required; a
  per-owner `message_id` dedup at intake would tighten it if ever desired.
- **GAP-18 — INFO — Eval gates sit below the spec's aspirational floors** (0.7 vs 0.85
  precision) with an explicit honest-floor, ratchet-up-only rationale in `gates.json` —
  deliberate and documented, not a defect.

---

## v1 Definition-of-Done sweep (Roadmap Revision lines 43–48)

| # | DoD bullet | Verdict | Evidence / gap |
|---|---|---|---|
| 1 | Stranger onboarded via one script + checklist → working TLS single-tenant Cogeto with live inbound address, < 1 hour | **MET (repo)** — wall-clock unverifiable statically; **caveat GAP-2** (inbound TLS) | `scripts/operator/cogeto` install/checklist; `project/infra/deploy/` pull-only stack incl. `mail`; runbook lifecycle |
| 2 | Captures notes/email/files; remembers, verifies, consolidates (dreaming), open loops, answers with sources, time-travel diff | **MET** — **caveat GAP-4** (invite parts) | connectors + memory + tasks + dreaming + retrieval citations + timeline |
| 3 | Inspect + correct everything, provable deletion with signed receipt, Memory Passport export | **MET** | deletion saga + receipts (email cascade incl.); Passport export all-statuses, signed, offline-verifiable |
| 4 | Upgrade via script subcommand; restore from OVH backup by rehearsed procedure | **MET** | `cmd_upgrade` + runbook §6; rehearsed restore runbook §5c |
| 5 | Public trust-score page + compliance one-pager LIVE | **NOT MET (external repo)** | **GAP-3** — website deliverables absent; data side ready |
| 6 | Both audits pass | **IN PROGRESS** | this gap re-run + `launch-security-audit.md`; passing requires the HIGH items resolved/ruled |

**Bottom line:** the O4–O7 build is careful and largely done — 12/14 email rows, all O5/O6
surfaces, and the trust-scores artifact meet their Roadmap rows with real tests. The launch
gate hinges on four HIGH items: the two internet-facing SMTP gaps (inert limits, no
STARTTLS), the missing website deliverables (owner), and the dropped invite-part parser
(fix or file a deferral). The corpus should reach 50/language, and the intake edge exposure
+ auth-path test should close alongside the security siblings.
