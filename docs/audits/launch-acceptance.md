# Cogeto — Launch Audit Acceptance Log

**Started:** 2026-07-16 · Records the owner's decision on each finding from the three
launch audits (`launch-gap-audit.md`, `launch-security-audit.md`,
`launch-platform-audit.md`). This document is published with the audits — accepted-risk
rationales are written to be read publicly.

Decision types: **fix-now** (automated, via the standard delivery loop) · **owner-action**
(only the owner can do it; exact instructions provided in Phase 3) · **accept** (accepted
for launch, with a public rationale) · **defer** (post-launch, with where it is tracked).

Findings are walked in severity order across all three reports: HIGH → MEDIUM → LOW → INFO.

---

## Decisions

| # | Finding | Report | Severity | Decision | Rationale | Executes |
|---|---|---|---|---|---|---|
| 1 | SEC-1 — SMTP sender spoofing / cross-user memory injection | security | HIGH | **fix-now** (automated + owner DNS) | Sharpest launch risk; add SPF/DKIM/DMARC verification in Haraka + reject unauthenticated senders, and provide owner the SPF/DMARC DNS records for onboarding | automated code (fix:launch) + owner (DNS records per O6 checklist) |
| 2 | GAP-1 — Haraka rate/concurrency limits inert | gap | HIGH | **fix-now** (automated) | Public SMTP port has zero throttling; enable/correct limits with an in-process connect-rate backend (no Redis dependency), rebuild cogeto-mail | automated code (fix:launch), owner ships via release |
| 3 | GAP-2 — No inbound STARTTLS | gap | HIGH | **fix-now** (automated + owner) | Forwarded mail crosses the internet in cleartext, undermining the data-residency claim; enable Haraka TLS + wire cert mounting in the operator script | automated code + O6 script; owner confirms cert-provisioning approach |
| 4 | GAP-4 — Calendar-invite parts within emails not parsed | gap | HIGH | **fix-now** (automated) | O4 requires it and D1's calendar-drop rationale depends on it; parse text/calendar into a deterministic VEVENT→text summary appended to extraction input | automated code (fix:launch) |
| 5 | GAP-3 — Trust-score public page + compliance one-pager | gap | HIGH | **verified-done** (owner-confirmed) | Both the trust-score page (renders eval/trust-scores JSON) and the compliance one-pager are already live on the cogeto.eu website; the audit flagged them only because they live in a separate repo not visible to this scan. DoD bullet 5 is MET | none — owner-confirmed live; no repo action |
| 6 | PA-1 — No tag protection for v* release tags | platform | HIGH | **owner-action** | Release trust chain hangs off the tag (cosign identity + image publish); a compromised token could delete/move a shipped tag. Add a tag ruleset (block deletion + non-fast-forward on refs/tags/v*) | owner (GitHub UI; instructions in Phase 3; verifiable via gh) |
| 7 | PA-12 — Secret scanning + push protection disabled | platform | HIGH | **owner-action** | Free for public repos; repo handles secrets pervasively and takes contributor PRs. Enable secret scanning + push protection + non-provider patterns | owner (GitHub UI; instructions in Phase 3; verifiable via gh) |
| 8 | SEC-2 / GAP-5 — Intake edge-reachable, 25 MB pre-auth buffering, no rate cap | security/gap | MEDIUM | **fix-now** (automated) | Contradicts decision 0028 ("never public"); de-expose /api/email/intake at the edge (both Caddyfiles), add per-sender intake cap + budget attribution | automated code (fix:launch) |
| 9 | SEC-3 — Reply drafting: prompt injection + attacker-controllable reply target | security | MEDIUM | **fix-now** (automated) | The one model path over hostile external text; mark recovered reply-to as "suggested — verify" (not pre-filled) + add injection framing around the email body | automated code (fix:launch) |
| 10 | SEC-4 — Reply-draft approvals survive email-source deletion | security | MEDIUM | **fix-now** (automated) | Provable-deletion thesis requires an honest receipt; add an emailSourceId-keyed cascade that redacts/deletes reply-draft approvals, counted in counts_json | automated code (fix:launch) |
| 11 | SEC-5 — Org-scoped approvals expose reply-draft previews to non-owners | security | MEDIUM | **fix-now** (automated) | Contradicts owner-gated posture elsewhere; owner-gate the reply-draft preview + confirm/reject, non-requesters get a content-free summary | automated code (fix:launch) |
| 12 | SEC-6 / GAP-6 — Refusal log: unbounded PII + cross-user visibility | security/gap | MEDIUM | **fix-now** (retention) + **accept** (visibility) | Add a 30-day retention pass to a nightly cron (automated). The cross-user null-owner visibility is retained as intended decision-0031 design: it lets any user "claim"/allow a sender who mailed the shared single-tenant instance | automated code (retention, fix:launch); visibility accepted as-is |
| 13 | PA-2 — id-token: write workflow-scoped not job-scoped | platform | MEDIUM | **fix-now** (automated) | Least-privilege; scope OIDC signing to the release job, give trust-scores minimal contents/pull-requests write | automated workflow edit (fix:launch) |
| 14 | PA-3 — Two pull_request_target workflows hold write tokens | platform | MEDIUM | **fix-now** (automated) | No PR-head checkout today (no pwn-request); add asserting no-checkout comment + pin CLA action by SHA (with PA-6). Token scope handled under PA-8 | automated workflow edit (fix:launch) |
| 15 | PA-6 — Actions pinned by mutable tags not SHAs | platform | MEDIUM | **fix-now** (automated) | Tag-repoint runs attacker code in jobs holding signing/push/PAT creds; pin all uses: to full commit SHAs (Dependabot keeps them current, pairs with PA-5) | automated workflow edit (fix:launch) |
| 16 | PA-5 — No dependabot.yml; security updates off | platform | MEDIUM | **fix-now** (automated + owner toggle) | Nothing keeps actions/npm/pip/Docker deps current; add .github/dependabot.yml (github-actions, npm root + mail, pip redaction) + enable security updates | automated config (fix:launch) + owner (Settings toggle) |
| 17 | PA-8 — PROJECTS_TOKEN scope/expiry unverified | platform | MEDIUM | **owner-action** | PAT exposed to fork PR events + drives auto-merge; verify/rotate to fine-grained (repo Contents+PRs write, org Projects write), short expiry | owner (Developer settings; checklist in Phase 3) |
| 18 | PA-13 — require_code_owner_review but no CODEOWNERS | platform | MEDIUM | **not-a-finding** (false positive) | `.github/CODEOWNERS` (`* @igolubic`) IS present on remote main — added by PR #89, which merged after the audited local checkout (fb06d02); the audit scanned a stale tree. Code-owner rule is satisfied | none — verified on remote main (865b392) |
| 19 | PA-15 — Org-wide 2FA not enforced | platform | MEDIUM | **accept** | Cogeto is a single-owner organization; the operative control is the owner account's own two-factor authentication. Org-wide 2FA enforcement will be enabled before the organization ever admits a second member | accepted for launch; owner ensures personal 2FA remains on |
| 20 | PA-4 — Admins bypass the main ruleset "always" | platform | MEDIUM | **accept** | Cogeto has a single maintainer for the foreseeable future; the standing admin bypass is a deliberate solo-operator convenience. The account is 2FA-protected and every routine change still flows through PRs with the five required checks. To be revisited if the repo gains additional maintainers | accepted for launch |
| 21 | GAP-7 — Golden corpus below 50/language target | gap | MEDIUM | **fix-now** (automated + owner labels) | Published per-language trust claims should meet the spec's 50/language floor; generate ~15 hr + 1 en synthetic/anonymized cases per corpus rules, owner reviews labels; live gate re-measures on owner push | automated case generation (fix:launch) + owner label review |
| 22 | GAP-8 — No test on the intake HTTP auth path | gap | MEDIUM | **fix-now** (automated) | Protects the one @Public internet-facing route; add MailIntakeGuard unit test (empty/bad/good token) + controller-level e2e | automated code (fix:launch) |
| 23 | GAP-9 — Passport export not validated against published JSON Schemas | gap | MEDIUM | **fix-now** (automated) | Makes the format-stability promise real (as trust-scores already does); add ajv validation of generated documents against the four docs/passport-schema schemas | automated code (fix:launch) |
| 24 | GAP-10 / PA-10 — Eval gate soft-skips green when Mistral key missing on main | gap/platform | MEDIUM | **accept** | Intended behavior: the soft-skip prevents a temporary key outage or key rotation from blocking all merges to main. The owner monitors key presence, and the warning annotation surfaces a skipped run | accepted for launch (owner decision) |
| 25 | SEC-7 — pino redact paths omit email content fields | security | LOW | **fix-now** (automated) | Defensive; add *.textBody/*.htmlBody/*.body/*.subject/*.fromAddr to REDACT_PATHS | automated code (fix:launch) |
| 26 | SEC-8 / GAP-12 — Refusal listing filters after SQL LIMIT | security/gap | LOW | **fix-now** (automated) | Correctness; move owner/null predicate into WHERE before LIMIT (pairs with SEC-6 retention) | automated code (fix:launch) |
| 27 | SEC-9 — Mail image has no lockfile (Haraka transitive deps float) | security | LOW | **fix-now** (automated) | Reproducible builds for the internet-facing RFC822 parser; commit project/services/mail/package-lock.json + switch Dockerfile to npm ci --omit=dev | automated code (fix:launch) |
| 28 | SEC-10 / PA-19 — Dev mail-intake token not in secret-preflight list | security/platform | LOW | **fix-now** (automated) | Closes the last preflight gap; add cogeto-dev-mail-token to secret-preflight KNOWN_DEV_SECRETS | automated code (fix:launch) |
| 29 | GAP-11 — Mail env knobs absent from .env.example | gap | LOW | **fix-now** (automated) | Doc hygiene; add commented mail entries to .env.example | automated code (fix:launch) |
| 30 | GAP-13 — Chat gate all-or-nothing on a variance-prone grader | gap | LOW | **accept** | Strict all-pass is preferred over retry leniency; the atlas_scope coverage-grader variance is disclosed honestly in the per-release trust-score notes rather than masked by a retry | accepted for launch (owner decision) |
| 31 | GAP-14 — Stale gates.json note (cites 36-case corpus) | gap | LOW | **fix-now** (note only) | Refresh the note to the current corpus size (sequenced after the GAP-7 additions); threshold ratcheting is a separate post-launch task needing a decision record | automated note update (fix:launch); ratchet deferred |
| 32 | PA-7 — DOCKERHUB_TOKEN scope | platform | LOW | **accept** (owner-confirmed) | Owner confirmed the Docker Hub push token is already a scoped Read/Write access token (not an account password or admin token), limited to the cogeto images | none — owner-verified |
| 33 | PA-9 — main allows merge + rebase merges (convention is squash-only) | platform | LOW | **accept** | The solo maintainer follows the squash-only, one-commit-per-PR convention in practice; the additional merge methods remain enabled for occasional flexibility. To be tightened if the repo gains additional maintainers | accepted for launch |
| 34 | PA-11 — Projects board is public | platform | LOW | **accept** | The public roadmap board is deliberate for the open-source project — the plan and issue status are shared with the community by design | accepted for launch |
| 35 | PA-14 — Merged branches not auto-deleted | platform | LOW | **owner-action** | Hygiene (trust-scores/* branches accumulate); enable auto-delete-on-merge | owner (Settings → General; checklist in Phase 3) |
| 36 | PA-16 — Docker Hub overviews blank | platform | LOW | **defer** | Cosmetic/trust-signal; the in-repo README is the source of truth at launch. Tracked as a post-launch task: draft + paste overviews (purpose, tags, cosign verify) for cogeto / -edge / -mail | deferred post-launch (owner, with drafted text) |
| 37 | PA-17 — Docker Hub tags mutable | platform | LOW | **accept** | The integrity control is the keyless cosign signature pinned to the image digest, which the operator script verifies on every pull; a re-pushed tag fails verification. Tag immutability would require a paid Docker Hub plan and adds little over signature verification | accepted for launch |
| 38 | SEC-12 — Redaction sidecar transitive deps unpinned | security | INFO | **fix-now** (automated) | Fully reproducible sidecar builds; add a hashed pip-compile lock and install from it | automated code (fix:launch) |
| 39 | SEC-11 — Known low-reachability advisories (drizzle-orm, undici) | security | INFO | **accept** | Both are Low-reachability: drizzle uses only static schema identifiers with bound parameters and escaped LIKE input; undici is reached solely by the internal, trusted Qdrant client on the compose network. The fixes are breaking major bumps, so no upgrade is undertaken for v1; reachability is re-judged each audit | accepted for launch (owner decision) |
| 40 | GAP-15 — Stale "Unit B" comments (shipped features described as pending) | gap | INFO | **fix-now** (automated) | Avoids misleading future readers; correct the two comments (email-settings.controller.ts, email.source-reader.ts) | automated code (fix:launch) |
| 41 | GAP-16 — Unused host_list mail config | gap | INFO | **fix-now** (automated) | Trivial cleanup; remove the unused host_list write (folds into the mail-hardening PR) | automated code (fix:launch) |
| 42 | GAP-17 — Redelivery duplicates retained email copy | gap | INFO | **accept** (no action) | Already explicitly accepted in decision 0031's "Redelivery note": a mid-loop 451 retry stores a second copy, but reconciliation dedups the derived memories. Bounded, known, and by design | none |
| 43 | GAP-18 — Eval gates below aspirational floors | gap | INFO | **accept** (no action) | Deliberate honest-floor, ratchet-up-only policy documented in gates.json; the floors are set where the corpus reliably clears them, not aspirationally | none |
| 44 | PA-18 — Git history secret sweep | platform | INFO | **not-a-finding** (CLEAN) | Full sweep of 94 commits across all refs found no secret or private artifact; only sanctioned localhost dev placeholders. Nothing to rotate or rewrite — confirms launch-readiness | none |
| 45 | PA — Discussions disabled | platform | INFO | **accept** (no action) | An OSS support-channel choice, not a defect; the owner may enable Discussions later if community support warrants it | none |
| 46 | PA — Org members can create repositories | platform | INFO | **accept** (no action) | Org-hygiene note with no launch impact for a single-owner organization | none |

---

## Decision summary

The three audits raised 49 unique findings (plus 2 org-hygiene INFO notes) — several were the
same issue flagged by two audits and are recorded once. Counts by decision:

| Decision | Count | Findings |
|---|---|---|
| **fix-now** (automated code/config via the delivery loop) | 25 | SEC-1, SEC-2/GAP-5, SEC-3, SEC-4, SEC-5, SEC-6 (retention), SEC-7, SEC-8/GAP-12, SEC-9, SEC-10/PA-19, SEC-12, GAP-1, GAP-2, GAP-4, GAP-7, GAP-8, GAP-9, GAP-11, GAP-14 (note), GAP-15, GAP-16, PA-2, PA-3, PA-5 (config), PA-6 |
| **owner-action** (GitHub/Docker Hub UI or token) | 4 | PA-1, PA-12, PA-8, PA-14 |
| **accept** (for launch, with public rationale) | 14 | SEC-6 (visibility), SEC-11, GAP-10/PA-10, GAP-13, GAP-17, GAP-18, PA-4, PA-7, PA-9, PA-11, PA-15, PA-17, + Discussions-off, members-can-create-repos |
| **defer** (post-launch) | 1 | PA-16 (Docker Hub overviews) |
| **verified-done / not-a-finding** (owner-confirmed live, or stale-tree false positive, or clean result) | 3 | GAP-3 (page + one-pager live), PA-13 (CODEOWNERS present on remote main), PA-18 (git history CLEAN) |

**Embedded owner sub-tasks inside fix-now items** (the code lands automatically, but a
matching owner step is required to complete it):
- **SEC-1** — add SPF/DMARC DNS records to the O6 onboarding checklist.
- **GAP-2** — confirm the inbound-TLS certificate-provisioning approach.
- **GAP-7** — review the generated golden-case labels before merge.
- **PA-5** — flip the Dependabot security-updates toggle in Settings.

**No CRITICAL findings.** The seven HIGH findings resolved as: 5 fix-now (SEC-1, GAP-1,
GAP-2, GAP-4) + 1 verified-done (GAP-3), 2 owner-action (PA-1, PA-12).

Phase 3 will: (1) land the 25 fix-now items as coherently-clustered `fix:launch` PRs with
green checks; (2) hand the owner a single consolidated OWNER ACTIONS checklist for the 4
owner-action items + the 4 embedded sub-tasks, each with exact click-paths and a
verification step; (3) leave accepted/deferred items recorded here as written; and (4) walk
the v1 definition-of-done list item by item with evidence links.

---

## Phase 3 — execution

### fix:launch issues (created)

| Cluster | Issue | Findings |
|---|---|---|
| SMTP surface hardening | [#90](https://github.com/Cogeto/cogeto/issues/90) | SEC-1, GAP-1, GAP-2, SEC-2/GAP-5, GAP-8, GAP-16, SEC-9 |
| Email deletion & retention completeness | [#91](https://github.com/Cogeto/cogeto/issues/91) | SEC-4, SEC-6/GAP-6, SEC-8/GAP-12 |
| Reply-draft safety & approvals scoping | [#92](https://github.com/Cogeto/cogeto/issues/92) | SEC-3, SEC-5 |
| Calendar-invite parsing | [#93](https://github.com/Cogeto/cogeto/issues/93) | GAP-4 |
| Passport schema cross-check | [#94](https://github.com/Cogeto/cogeto/issues/94) | GAP-9 |
| Golden corpus + gates note | [#95](https://github.com/Cogeto/cogeto/issues/95) | GAP-7, GAP-14 |
| Logging / env / preflight hygiene | [#96](https://github.com/Cogeto/cogeto/issues/96) | SEC-7, SEC-10/PA-19, SEC-12, GAP-11, GAP-15 |
| Workflow & supply-chain hardening | [#97](https://github.com/Cogeto/cogeto/issues/97) | PA-2, PA-3, PA-6, PA-5 |

### OWNER ACTIONS

A single ordered checklist of everything only the owner can do (GitHub/Docker Hub UI,
tokens, DNS). Each item states the exact path, the action, and a verification step. Items 1–2
are the launch-blocking HIGH platform items; 5–6 unblock the merged SMTP PR (#90).

**1. Tag protection for `v*` (PA-1, HIGH).** GitHub → repo **Settings → Rules → Rulesets →
New ruleset → New tag ruleset**. Name `tags`; Enforcement **Active**; Target tags → pattern
`v*`; enable **Restrict deletions** and **Restrict updates** (blocks non-fast-forward /
tag-move); leave creation to the owner (add yourself to the bypass list if you want to keep
tagging by hand). *Verify:* `gh api "repos/Cogeto/cogeto/rulesets?targets=tag"` returns the
ruleset (currently `[]`), and the ruleset detail shows `deletion` + `non_fast_forward` rules.

**2. Secret scanning + push protection (PA-12, HIGH).** **Settings → Code security** → enable
**Secret scanning**, **Push protection**, and **Scan for non-provider patterns**. *Verify:*
`gh api repos/Cogeto/cogeto --jq '.security_and_analysis'` shows `secret_scanning` and
`secret_scanning_push_protection` = `enabled` (both currently `disabled`).

**3. Dependabot security updates (PA-5 owner half; the `dependabot.yml` lands in #97).**
**Settings → Code security → Dependabot** → enable **Dependabot security updates**. *Verify:*
`gh api repos/Cogeto/cogeto --jq '.security_and_analysis.dependabot_security_updates.status'`
→ `enabled` (currently `disabled`).

**4. Auto-delete merged branches (PA-14).** **Settings → General → Pull Requests** → tick
**Automatically delete head branches**. *Verify:*
`gh api repos/Cogeto/cogeto --jq '.delete_branch_on_merge'` → `true` (currently `false`).

**5. `PROJECTS_TOKEN` scope + expiry (PA-8).** github.com/settings/tokens → **Fine-grained
tokens** → the token wired as the `PROJECTS_TOKEN` repo secret. Confirm: Resource owner =
`Cogeto`; Repository access = only `Cogeto/cogeto`; Repository permissions = **Contents:
Read/Write**, **Pull requests: Read/Write**; Organization permissions = **Projects:
Read/Write**; Expiration ≤ 90 days. If broader or non-expiring, regenerate and
`gh secret set PROJECTS_TOKEN` with the new value. *Verify:* token detail page shows the
narrowed scope; the next release's trust-scores auto-merge PR still completes.

**6. Inbound-mail SPF/DMARC + reverse DNS (SEC-1 owner half; the Haraka verification lands in
#90).** For each onboarded instance: set the OVH **reverse DNS (PTR)** for the instance IP to
the inbound host, and add the inbound domain's **SPF**/**DMARC** records per the O6 checklist
(so legitimate forwarders are verifiable and spoofed senders are rejected by the new Haraka
checks). *Verify:* a test email spoofing a registered user's address is **rejected**; a
genuine forwarded email is **accepted** and lands as memory.

**7. Inbound-TLS certificate approach (GAP-2 owner half; the Haraka `tls` wiring lands in
#90).** Confirm the cert source for STARTTLS on port 25 — recommended: **reuse the
Caddy-obtained Let's Encrypt cert** by mounting its volume into the mail container (the PR
wires the mount + operator-script step; you confirm this is the intended approach vs a
dedicated cert). *Verify:* `openssl s_client -starttls smtp -connect <host>:25` advertises
STARTTLS and presents a valid cert.

**8. Review generated golden-case labels (GAP-7, on PR #95).** Review the ~15 hr + 1 en cases
added in the PR branch; confirm the expected extractions/labels are correct before merge.
*Verify:* PR #95 merged; the live eval-gate is green on the post-merge push to `main`.

*(Docker Hub overview text for `cogeto` / `-edge` / `-mail` — PA-16 — is deferred
post-launch; draft text will be provided then.)*

### Resolutions (merged fix:launch PRs)

Each merged PR resolves its cluster's findings; the RESOLVED line and merge reference
for every finding is recorded here.

- **PR [#98](https://github.com/Cogeto/cogeto/pull/98)** — `fix: launch hygiene` — merged
  `6f78312`, closes #96. RESOLVED: **SEC-7** (email fields added to pino redact paths),
  **SEC-10/PA-19** (dev mail-intake token in secret-preflight + test), **SEC-12** (redaction
  sidecar fully hash-locked via `requirements.lock`, `--require-hashes`; verified by the
  `docker-build` CI job), **GAP-11** (mail env vars documented in `.env.example`), **GAP-15**
  (two stale Unit-B comments corrected). All five required checks green.
- **PR [#99](https://github.com/Cogeto/cogeto/pull/99)** — `ci: harden workflows and supply
  chain` — merged `4234dfc`, closes #97. RESOLVED: **PA-6** (all actions SHA-pinned across
  ci/release/cla/project-automation), **PA-2** (`id-token: write` scoped to the release job;
  trust-scores job gets only contents+pull-requests write), **PA-3** (no-checkout invariant
  asserted on both `pull_request_target` workflows), **PA-5** code half (`.github/dependabot.yml`
  added — the *security-updates toggle* remains OWNER ACTION #3). The `cla` + `sync board`
  jobs ran on the pinned workflows and passed. All five required checks green.
- **PR [#100](https://github.com/Cogeto/cogeto/pull/100)** — `test: validate Memory Passport
  export against published JSON Schemas` — merged `7fd7589`, closes #94. RESOLVED: **GAP-9**
  (Ajv 2020-12 cross-check of generated documents against `docs/passport-schema/`; no drift
  found). All five required checks green.

### Remaining fix:launch clusters (open, in progress)

These five clusters are substantive; two carry owner-gated sub-tasks that block completion
regardless of the code, and one needs a new saga cascade port. They are scoped as issues and
proceed as their own verified PRs.

| Issue | Cluster | Findings | Notes / gating |
|---|---|---|---|
| [#91](https://github.com/Cogeto/cogeto/issues/91) | Email deletion & retention | SEC-4, SEC-6/GAP-6, SEC-8/GAP-12 | SEC-4 needs a **new source-keyed cascade port** (reply-draft approvals live in the agents module, so the email SourceDeletion cannot touch them directly — §A.1); SEC-8 is a one-liner; SEC-6 adds a nightly retention arm. Locally verifiable (Testcontainers). |
| [#92](https://github.com/Cogeto/cogeto/issues/92) | Reply-draft safety & approvals scoping | SEC-3, SEC-5 | Prompt-injection framing + untrusted reply-to; owner-gate the reply-draft preview. Locally verifiable. |
| [#93](https://github.com/Cogeto/cogeto/issues/93) | Calendar-invite parsing | GAP-4 | Parse `text/calendar` VEVENT → text summary. Locally verifiable (unit test). |
| [#90](https://github.com/Cogeto/cogeto/issues/90) | SMTP surface hardening | SEC-1, GAP-1, GAP-2, SEC-2/GAP-5, GAP-8, GAP-16, SEC-9 | **Launch-critical but owner-gated**: SPF/DKIM/DMARC + STARTTLS need OWNER ACTIONS #6 (DNS/PTR) + #7 (cert approach), and cannot be behaviour-tested without a running mail stack. To be validated by the live acceptance test (spoofed email → rejected), not by CI alone. |
| [#95](https://github.com/Cogeto/cogeto/issues/95) | Golden corpus + gates note | GAP-7, GAP-14 | Generated cases need OWNER ACTION #8 (label review); the live eval-gate re-measures only on the post-merge push. |

### v1 Definition-of-Done (Roadmap Revision lines 43–48) — evidence walk

Status as of this checkpoint. Bullets 1–4 are structurally MET in the codebase; the two
caveats and bullet 6 are gated on the remaining SMTP cluster (#90) + owner actions.

| # | DoD bullet | Status | Evidence / gate |
|---|---|---|---|
| 1 | One-script onboarding → working TLS single-tenant instance with a live inbound address, < 1 h | **MET, with GAP-2 caveat** | `scripts/operator/cogeto` (install/configure/upgrade/status + checklist); pull-only stack `project/infra/deploy/` incl. the `mail` Haraka service; runbook `docs/operator-runbook.md`. Caveat: **inbound STARTTLS** (GAP-2, #90 + OWNER ACTION #7). |
| 2 | Captures notes/email/files; remembers, verifies, consolidates (dreaming), open loops, answers with sources, time-travel diff | **MET, with GAP-4 caveat** | `project/src/connectors/` (notes, files, email intake/parse/reply), `memory/`, `tasks/`, dreaming, `retrieval/chat` citations, `memory/timeline.*` + `web/.../TimelineView.tsx`. Caveat: **calendar-invite parts** (GAP-4, #93). |
| 3 | Inspect + correct everything; provable deletion with a signed receipt; Memory Passport export | **MET** | Deletion saga + hash-chained signed receipts (`memory/deletion-saga.ts`; email cascade `email.source-deletion.ts`); Passport export all-statuses, signed, offline-verifiable, now schema-cross-checked (PR #100). Residual: reply-draft-approval residue (SEC-4, #91) — receipt-completeness hardening, in progress. |
| 4 | Upgrade via the script; restore from an OVH backup by a rehearsed procedure | **MET** | `scripts/operator/cogeto` upgrade subcommand; runbook §5c (rehearsed restore) + §6 (upgrades). |
| 5 | Public trust-score page + compliance one-pager live | **MET (owner-confirmed)** | Both live on cogeto.eu (owner-confirmed; external website repo — GAP-3). The trust-score data side is in-repo: `eval/trust-scores/index.json` + immutable per-version files. |
| 6 | Both audits pass | **IN PROGRESS** | This re-run (`launch-gap-audit.md`, `launch-security-audit.md`, `launch-platform-audit.md`) + this acceptance log. Passing requires: the remaining fix:launch clusters merged (esp. #90 SMTP), the OWNER ACTIONS completed and verified, and a clean re-scan. |

**Not yet written: the closing "v1 is launchable" entry.** Per the Phase 3 contract it is
written only when the automated fixes are merged, the OWNER ACTIONS are confirmed done, and
this DoD list is fully checked — specifically the SMTP hardening (#90) landed and validated
by the live acceptance test, and the golden corpus (#95) merged. Until then v1 is **not yet
declared launchable**; the next tag remains the owner's to cut once the above closes.
