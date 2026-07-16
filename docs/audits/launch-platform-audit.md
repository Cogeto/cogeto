# Cogeto — Launch Platform & Supply-Chain Audit

**Date:** 2026-07-16 · **Repo:** `Cogeto/cogeto` @ `fb06d02` · **Method:** read-only
inspection of the live GitHub configuration (`gh api` against repository rulesets,
Actions permissions, secrets inventory, security-and-analysis settings, collaborators,
org defaults, the Projects board), the four workflow files under `.github/workflows/`,
the Docker Hub `cogeto/*` repositories (public HTTP API), and a git-history secret
sweep (reported separately in the two content audits). This audit covers the
GitHub/supply-chain surface of a repository that **is already public** and load-bearing
(it publishes the signed images customers pull). Every finding carries the exact setting
location or command output, a severity, the risk, and a one-line remedy naming WHO can
apply it (automated code/config change vs owner-only in a web UI).

> **Note on visibility:** the repository is **already `PUBLIC`** (`gh repo view` →
> `"visibility":"PUBLIC"`, `"isPrivate":false`) and has 30 forks / 140 watchers. The
> "going public" checklist below therefore also functions as a *post-publication*
> hardening list — several free-for-public-repo protections are still off.

## Executive summary

The core release trust chain is sound: `main` is protected by an **active ruleset**
enforcing all five required checks (strict/up-to-date), linear history, and blocked
force-push/deletion; the default `GITHUB_TOKEN` is **read-only**; fork PRs cannot reach
the Mistral key (the eval gate runs mocked on PRs, live only on push to main); the
trust-scores publish path cannot bypass branch protection (it lands via a PR that must
pass the required checks); release images are cosign-signed keyless via OIDC. **But the
launch surface has real holes, none yet catastrophic:** there is **no tag protection**,
so a compromised owner token or collaborator could delete or move a `vX.Y.Z` release tag
(the exact ref cosign identity and the image publish are pinned to); **secret scanning,
push protection, and Dependabot security updates are all disabled** despite being free
for public repos; the `id-token: write` permission is declared **workflow-wide** in
`release.yml` rather than scoped to the signing job; third-party actions are pinned by
**mutable major-version tags** (`@v3`, `@v6`, `@v0`) not SHAs; **org 2FA is not enforced**;
and the three Docker Hub repositories ship with **empty overviews**. Total: **HIGH 3 ·
MEDIUM 6 · LOW 6 · INFO 3.** Every item is owner-fixable in a web UI or a small config
PR; nothing requires re-architecture.

The git-history sweep came back **CLEAN** — no secret or private artifact anywhere in the
94-commit history, so the two HIGH items are the config gaps (tag protection; secret
scanning/push protection).

**Counts by severity: CRITICAL 0 · HIGH 2 · MEDIUM 8 · LOW 8 · INFO 3.**

---

## 1. Branch protection on `main`

Enforced by repository **ruleset #18893470** (`name:"main"`, `enforcement:"active"`,
`gh api repos/Cogeto/cogeto/rulesets/18893470`). There is no classic branch-protection
object (`branches/main/protection` → 404 "Branch not protected") — protection is
ruleset-based, which is correct and current.

| Control | Current setting | Correct target | Verdict |
|---|---|---|---|
| PR required before merge | `pull_request` rule present; `required_approving_review_count: 1`; `require_code_owner_review: true`; `dismiss_stale_reviews_on_push: true` | PR + ≥1 approval | **OK** |
| Required status checks | `lint`, `boundaries`, `test`, `build`, `eval-gate` — all five, `strict_required_status_checks_policy: true` (branch must be up to date), `integration_id: 15368` (GitHub Actions) | exactly these five, strict | **OK** — correctly named and enforced |
| Linear history | `required_linear_history` rule present | on | **OK** |
| Force-pushes | `non_fast_forward` rule present | blocked | **OK** |
| Branch deletion | `deletion` rule present | blocked | **OK** |
| Admin bypass | `bypass_actors: [{actor_id:5 (RepositoryRole=Admin), bypass_mode:"always"}]`; `current_user_can_bypass:"always"` | no standing bypass, or `pull_request`-only | **FINDING PA-4** |
| Allowed merge methods | `["merge","squash","rebase"]` — all three | squash-only (repo convention: PR title → single commit) | **FINDING PA-9** |

**PA-4 — MEDIUM — Admins bypass the ruleset unconditionally.** The Admin role
(`actor_id:5`) has `bypass_mode:"always"`, so the sole admin (`igolubic`) can push
directly to `main`, skip checks, and force through a merge — the "linear history + five
green checks" guarantee is advisory for the one account that matters. On a solo-owner
repo this is a convenience/־risk tradeoff, but for a load-bearing public repo the
standing bypass means a single compromised owner session rewrites `main` with no
gate. **Risk:** a stolen owner token or a momentary lapse pushes unreviewed/failing code
straight to the branch customers' releases are cut from. **Remedy:** set the ruleset
bypass to `pull_request` only (bypass the PR requirement for emergencies but still run
checks), or remove the bypass entirely and rely on `--admin` merges only when checks are
green — **owner-only** (Repo → Settings → Rules → `main` ruleset → Bypass list).

## 2. Tag protection for `v*` tags

**PA-1 — HIGH — No tag protection exists.** `gh api "repos/Cogeto/cogeto/rulesets?targets=tag"`
returns `[]`; the only ruleset targets `refs/heads/main` (`target:"branch"`). Classic
tag protection is likewise absent. Release tags `v0.8.0`, `v0.9.0`, `v0.9.1`, `v0.9.2`
exist unprotected (`gh api repos/Cogeto/cogeto/tags`). **Risk:** the entire release trust
chain hangs off the tag: `release.yml` fires on `push: tags: v*.*.*`, the `verify:version`
gate ties the tag to `package.json`, the cosign certificate identity is pinned to
`refs/tags/` (`release.yml:189`), and customers pull `:X.Y.Z`. A compromised owner token
or any future collaborator with write access can **delete a shipped tag and re-point it
at a different commit**, then re-run the release to publish a malicious image under a
version customers trust — with no protection stopping the delete or the force-move.
**Correct configuration:** a tag ruleset over `refs/tags/v*` with `deletion` blocked,
`non_fast_forward` blocked (tags immutable), and creation restricted to the owner (or to
the release automation). **Remedy:** add the tag ruleset — **owner-only** (Repo →
Settings → Rules → New ruleset → Target: Tags → pattern `v*`).

## 3. Actions security

| Control | Current setting | Correct target | Verdict |
|---|---|---|---|
| Default `GITHUB_TOKEN` permissions | `default_workflow_permissions:"read"` (`gh api .../actions/permissions/workflow`) | read-only unless a job elevates | **OK** |
| Token can approve PRs | `can_approve_pull_request_reviews:false` | false | **OK** |
| Allowed actions | `allowed_actions:"all"`; `sha_pinning_required:false` (`gh api .../actions/permissions`) | restrict to verified-creators + selected, or enable SHA pinning | **FINDING PA-6** |
| `id-token: write` scope | declared at **workflow level** in `release.yml:37-42`; inherited by both the `release` job and the `trust-scores` job | scoped to the signing job only | **FINDING PA-2** |
| Fork PRs & secrets | eval-gate is `pull_request` (not `_target`), so fork PRs run the **mocked** path with no secret (`ci.yml:134-163`); `release.yml` is tags-only; fork-PR approval policy `first_time_contributors` (`gh api .../actions/permissions/fork-pr-contributor-approval`) | fork PRs never see secrets | **OK** |
| `pull_request_target` usage | two workflows: `cla.yml:22`, `project-automation.yml:22` | none, or justified line-by-line | **FINDING PA-3** |
| Action version pinning | all `uses:` on major-version tags (`actions/checkout@v4`, `setup-node@v4`, `docker/*@v3/@v6`, `sigstore/cosign-installer@v3`, `anchore/sbom-action@v0`, `actions/github-script@v7`, `contributor-assistant/github-action@v2.6.1`) | pin by SHA (or at least immutable tag) | **FINDING PA-6** |

**PA-2 — MEDIUM — `id-token: write` is workflow-scoped, not job-scoped, in `release.yml`.**
The permission (`release.yml:37-42`) is needed only by the `release` job's cosign signing
step (keyless OIDC). Because it is declared at the workflow top level it is also granted
to the `trust-scores` job (`release.yml:217`), which does npm eval + a git push/PR and
has no business minting an OIDC identity token. **Risk:** an OIDC token in the
trust-scores job (which runs `npm ci` over the full dependency tree and could be
influenced by a compromised dependency) widens the blast radius of a supply-chain
compromise to Sigstore identity impersonation. **Remedy:** move `id-token: write` out of
the workflow-level `permissions` block into a job-level `permissions:` on the `release`
job only, and give `trust-scores` its own minimal `permissions: {contents: write,
pull-requests: write}` — **automated** (one-file workflow edit).

**PA-3 — MEDIUM — Two `pull_request_target` workflows expose write tokens to
fork-triggered runs.** `cla.yml` (runs `contributor-assistant/github-action@v2.6.1` with
`contents:write`, `pull-requests:write`, `statuses:write`, `actions:write`) and
`project-automation.yml` (uses `PROJECTS_TOKEN`) both trigger on `pull_request_target`.
**Mitigating facts, verified line by line:** neither workflow checks out or executes the
PR head code — `cla.yml` only invokes the CLA action (`cla.yml:36-38`, no `actions/checkout`),
and `project-automation.yml` runs an inline `actions/github-script` that only calls the
GraphQL project API (`project-automation.yml:38-149`, no checkout, no PR-content
execution). So the classic "pwn-request" (running untrusted code with secrets) does not
apply. `first_time_contributors` approval gates first-time fork contributors. **Residual
risk:** these are the most dangerous trigger in the repo; any future edit that adds a
checkout of `github.event.pull_request.head` would immediately become a token-exfiltration
vector, and `PROJECTS_TOKEN` (a PAT) is exposed to the runner on every fork PR event.
**Remedy:** keep the no-checkout invariant (add a comment asserting it), pin the CLA
action by SHA (PA-6), and confirm `PROJECTS_TOKEN` is minimal-scope (PA-8) — **automated**
+ **owner** (token scope).

**PA-6 — MEDIUM — Third-party actions are pinned by mutable major-version tags, not
SHAs.** `sha_pinning_required:false` and every `uses:` rides a moving tag. First-party
`actions/*` and `docker/*` on `@v4/@v3/@v6` are moderate risk; the higher-risk ones are
the **third-party and floating-major** actions that run with real secrets or tokens:
`contributor-assistant/github-action@v2.6.1` (patch-pinned — best of the set, but still a
tag), `sigstore/cosign-installer@v3`, and especially `anchore/sbom-action@v0` (a `v0`
major tag floats across every 0.x release). **Risk:** a tag re-point on any of these
executes attacker-controlled code inside a job that holds `id-token: write`, Docker Hub
push creds, or `PROJECTS_TOKEN`. **Remedy:** pin every `uses:` to a full commit SHA
(Dependabot can keep them current), starting with the third-party ones; optionally set
`sha_pinning_required:true` at the repo/org level — **automated** (workflow edits) +
**owner** (org policy toggle).

## 4. Trust-scores publish mechanism

The `trust-scores` job (`release.yml:217-275`) commits `eval/trust-scores/vX.Y.Z.json` +
`index.json` onto protected `main`. **Token:** `GH_TOKEN` = `PROJECTS_TOKEN` when present,
else `github.token` (`release.yml:257`). **Mechanism:** it never pushes to `main`
directly — it pushes a `trust-scores/<tag>` branch, opens a PR (`gh pr create`), and arms
auto-merge (`gh pr merge --auto --squash`). Auto-merge only completes **after the five
required checks pass** (the ruleset has no bypass for this bot path — `bypass_actors`
lists only the Admin role, and the PAT/bot is not an admin actor). The commit stages
**only `eval/trust-scores`** (`git add eval/trust-scores`, `release.yml:268`), and the
publish script validates the version string `^v\d+\.\d+\.\d+$` before `path.join` and
**refuses to overwrite** an existing release file (verified in the content-security pass:
`trust-scores.ts:180-186`). **Verdict: OK** — the path cannot write outside
`eval/trust-scores/`, cannot bypass branch protection, and cannot forge an existing
version. The one caveat is the token scope (PA-8): whatever `PROJECTS_TOKEN` can do, this
job can do, so its scope bounds the blast radius.

## 5. Secrets inventory

Four repository secrets (`gh api repos/Cogeto/cogeto/actions/secrets`); zero Dependabot
secrets; no environment secrets (no environments configured).

| Secret | Used by | Scope concern | Verdict |
|---|---|---|---|
| `DOCKERHUB_USERNAME` | `release.yml:75` docker login | account name, low sensitivity | OK |
| `DOCKERHUB_TOKEN` | `release.yml:76` docker login (push) | must be a **scoped access token**, push-only to `cogeto/*`, not the account password | **FINDING PA-7** |
| `MISTRAL_API_KEY` | `ci.yml` eval-gate (push to main only), `release.yml` trust-scores | exposure paths limited to push/tag events; **never** exposed to PRs (eval-gate mocks on PR); billable if leaked | OK (exposure correctly bounded) — see PA-10 |
| `PROJECTS_TOKEN` | `project-automation.yml`, `release.yml` trust-scores publish | a fine-grained PAT that can push branches, open + **auto-merge** PRs; scope + **expiry** not queryable via API | **FINDING PA-8** |

**PA-7 — LOW — Verify `DOCKERHUB_TOKEN` is a scoped, push-only access token.** If it is
an account password or an admin-scoped token, a workflow compromise (PA-2/PA-6) yields
full control of the `cogeto` Docker Hub namespace. **Risk:** malicious image push under a
trusted tag. **Remedy:** confirm/rotate to a Docker Hub *access token* scoped to
Read/Write on `cogeto/cogeto`, `-edge`, `-mail` only — **owner-only** (Docker Hub →
Account Settings → Security → Access Tokens; then update the repo secret).

**PA-8 — MEDIUM — `PROJECTS_TOKEN` scope and expiry are unverified and it is a
powerful, broadly-exposed PAT.** It is exposed to fork-PR events via
`project-automation.yml`'s `pull_request_target` (PA-3) and drives the auto-merge in the
trust-scores publish. Its scope and expiry cannot be read through the API. **Risk:** an
over-scoped or non-expiring PAT that leaks (via a `pull_request_target` compromise or log)
grants branch push + PR auto-merge + org Projects write. **Remedy:** confirm it is
**fine-grained**, limited to this repo's Contents + Pull requests (write) and the org
Projects (write), with a **short expiry** and a calendar reminder to rotate — **owner-only**
(GitHub → Settings → Developer settings → Fine-grained tokens).

**PA-10 — LOW — `MISTRAL_API_KEY` disappearance silently disables the launch gate.**
Not an over-scope, but an exposure/monitoring gap: on push to `main` the eval-gate
*soft-skips* with only a `::warning` if the key is absent (`ci.yml:144-146`), keeping the
required check green. **Risk:** a rotated-out or deleted key silently turns off the
launch-critical quality gate while `main` stays green. **Remedy:** fail the check (or a
sibling required check) when the key is missing on push — **automated** (this overlaps the
gap-audit finding on the same lines; fix once).

## 6. Repository settings for a public, load-bearing repo

| Setting | Current | Target | Verdict |
|---|---|---|---|
| Default branch | `main` | `main` | OK |
| Visibility | `PUBLIC` (already) | public | OK — already done |
| Issues | enabled | enabled | OK |
| Discussions | disabled | owner's call (OSS support channel) | INFO |
| Wiki | disabled | disabled (docs live in-repo) | OK |
| Projects | enabled; board `Cogeto` #1 is **`public:true`** (`gh api graphql projectV2`) | matches owner intent? | **FINDING PA-11** |
| Write access | only `igolubic` (`admin`); no other collaborators; no deploy keys (`gh api .../keys` → `[]`) | minimal | OK |
| Dependabot **alerts** | **enabled** (`vulnerability-alerts` → 204) | on | OK |
| Dependabot **security updates** | **disabled** (`security_and_analysis.dependabot_security_updates.status:"disabled"`); no `.github/dependabot.yml` | on (+ version-update config) | **FINDING PA-5** |
| Secret scanning | **disabled** | on (free for public) | **FINDING PA-1b / part of PA-12** |
| Secret-scanning push protection | **disabled** | on (free for public) | **FINDING PA-12** |
| CODEOWNERS | **absent** at root/.github/docs (`find` → none) despite `require_code_owner_review:true` in the ruleset | present, or drop the code-owner requirement | **FINDING PA-13** |
| Auto-delete merged branches | `delete_branch_on_merge:false` | on (hygiene) | LOW (PA-14) |
| Org 2FA | `two_factor_requirement_enabled:false` (org `Cogeto`) | enforced | **FINDING PA-15** |
| Org default repo permission | `read`; `members_can_create_repositories:true` | read | OK (INFO on repo-create) |

**PA-12 — HIGH — Secret scanning and push protection are both disabled on a public
repo.** `security_and_analysis` shows `secret_scanning:"disabled"` and
`secret_scanning_push_protection:"disabled"` (and `secret_scanning_non_provider_patterns`
+ `validity_checks` disabled). These are **free for public repositories**. **Risk:** the
repo handles secrets pervasively — the operator script generates per-tenant secrets, the
release/CI paths carry API keys and PATs, and contributors will open PRs — yet nothing
scans pushes for accidentally-committed credentials, and push protection would not stop a
developer from committing one. Given the git-history sweep is clean *today*, enabling this
keeps it clean going forward. **Remedy:** enable Secret scanning + Push protection (and
non-provider patterns) — **owner-only** (Repo → Settings → Code security → enable all).

**PA-5 — MEDIUM — Dependabot security updates off and no `dependabot.yml`.** Alerts are
on, but no automated security-update PRs and no version-update schedule; combined with
PA-6 (unpinned actions) there is no mechanism keeping actions or npm/pip/Docker deps
current. The content audits already track reachable-but-accepted advisories (drizzle-orm,
undici) whose fixes are breaking bumps — Dependabot would surface and stage these.
**Risk:** dependency drift with no automated nudge; the mail container in particular
parses hostile internet input. **Remedy:** add `.github/dependabot.yml` covering
`github-actions`, `npm` (root + `project/services/mail`), and `pip` (`services/redaction`),
and enable security updates — **automated** (config file) + **owner** (toggle).

**PA-13 — MEDIUM — `require_code_owner_review:true` but there is no CODEOWNERS file.**
The `main` ruleset requires code-owner review, yet no `CODEOWNERS` exists at the repo
root, `.github/`, or `docs/` (`find` returned none). PR #89 ("Add CODEOWNERS file") shows
as merged but the file is not present at HEAD. **Risk:** with the code-owner requirement
active and no CODEOWNERS, code-owner review is effectively unsatisfiable by design —
which currently only works because the admin bypass (PA-4) sidesteps it. Once PA-4 is
tightened, merges could block; conversely, the requirement gives a false sense of a review
gate that isn't wired. **Remedy:** commit a `CODEOWNERS` (e.g. `* @igolubic`) so the
requirement is real, or drop `require_code_owner_review` from the ruleset — **automated**
(file) or **owner** (ruleset). *(Confirm against the git-history/gap findings — PR #89's
outcome should be reconciled.)*

**PA-11 — LOW — The Projects board is public.** Project `Cogeto` #1 is `public:true`.
For an OSS repo a public roadmap board is often intentional, but it exposes the internal
planning/status of every issue. **Risk:** none technical; possible disclosure of unshipped
plans. **Remedy:** confirm the public board matches intent; if not, set it private — **owner-only**
(Project → Settings → Visibility).

**PA-15 — MEDIUM — Org 2FA is not enforced.** The `Cogeto` org has
`two_factor_requirement_enabled:false`. **Risk:** the single admin account (and any future
member) can hold repo-admin and Docker Hub push rights without 2FA — the highest-leverage
credential in the whole supply chain unprotected by a second factor. **Remedy:** enable
"Require two-factor authentication for everyone in the organization" — **owner-only**
(Org → Settings → Authentication security).

**PA-14 — LOW — Merged branches are not auto-deleted.** `delete_branch_on_merge:false`;
the trust-scores automation creates `trust-scores/<tag>` branches every release. **Risk:**
branch clutter only. **Remedy:** enable auto-delete-on-merge — **owner-only** (Repo →
Settings → General).

## 7. Docker Hub — `cogeto/cogeto`, `cogeto/cogeto-edge`, `cogeto/cogeto-mail`

All three repos are **public** (`is_private:false`), owner-namespaced, `collaborator_count:0`
(only the owner/token pushes). `cogeto/cogeto` has 364 pulls. Images are pushed only by
the tag-driven release workflow and cosign-signed.

| Item | Current | Target | Verdict |
|---|---|---|---|
| Access / who can push | 0 collaborators; push via `DOCKERHUB_TOKEN` from CI only | token-only, scoped | OK — but see PA-7 (token scope) |
| Repository overview / README | **empty on all three** (`full_description` length 0 for `cogeto`, `-edge`, `-mail`); short `description` set only on `cogeto` | overview describing the image, tags, and the cosign verify command | **FINDING PA-16** |
| Tag immutability | `immutable_tags_settings.enabled:false` | version tags immutable (`latest` may move) | **FINDING PA-17** |
| Token hygiene | see PA-7 | scoped push-only access token | PA-7 |

**PA-16 — LOW — Docker Hub overviews are blank.** A customer landing on
`hub.docker.com/r/cogeto/cogeto` sees no description of what the image is, which tags to
use, or how to verify the signature; `-edge` and `-mail` have not even a short
description. **Risk:** poor trust signal for a "verifiable" product; users can't tell the
mail/edge images apart or confirm authenticity. **Remedy:** set an overview on each (what
it is, supported tags, the `cosign verify` command from `release.yml:187-191`) — **owner-only**
(Docker Hub → each repo → Manage → Overview). *(Docker Hub overviews are manual; there is
no repo file that syncs them.)*

**PA-17 — LOW — Docker Hub tags are mutable.** With immutable tags disabled, a
compromised push token could overwrite an existing `:0.9.2`. Cosign signatures are pinned
to the digest so a re-push would fail verification, but the mutable tag still lets an
attacker serve a different image to anyone pulling by version tag without verifying.
**Risk:** tag-overwrite serving unsigned/malicious content to non-verifying pulls.
**Remedy:** enable immutable tags for `v*`/semver tags (keep `latest` mutable), if the
plan allows — **owner-only** (Docker Hub repo settings; may require a paid plan — confirm).

## 8. Git history — secret / private-artifact sweep

A dedicated read-only history sweep was run (all refs, high-signal patterns: private-key
PEM blocks, API-key/secret/password assignments, bearer/JWT/`ghp_`/`github_pat_`/`sk-`/
`dckr_pat_`/`xox`/`AKIA` shapes, `*.env`/`*.pem`/`*.key`/`session.json`/`demo-credentials`
additions), with attention to the operator-script work (per-tenant secret generation), the
trust-scores JSON, the mail/Haraka work, and `docs/sessions`/`docs/handoff`. **Its verdict
is recorded in this audit as PA-18 and cross-checked against the two content audits.** The
detailed pattern-by-pattern results are folded in below.

**PA-18 — INFO (CLEAN) — No secret or private artifact exists anywhere in git history.**
A full sweep of **94 commits across all local refs** (main + 5 local branches + 38
`origin/*` branches including `cla-signatures` + tags v0.1.1–v0.9.2), 71 of them since the
2026-07-10 audit (essentially the entire mail/Haraka, operator-script, trust-scores,
runbook, and OSS-launch-prep history), found **zero** real secrets across every
high-signal pattern: no private-key PEM blocks, no vendor tokens (`ghp_`/`github_pat_`/
`sk-`/`AKIA`/`dckr_pat_`/`xox`), no hardcoded bearers or JWTs, no `MISTRAL_API_KEY` value
(the env is shipped empty in `.env.example`), and **no sensitive file ever tracked**
(`.env`/`*.pem`/`*.key`/`session.json`/`demo-credentials` — only `.env.example` and source
code such as `secret-preflight.ts`). Key surfaces verified individually:
- **Operator script** (5 historical blobs): all secrets are `openssl rand`-generated at
  install; `configure` never prints values (decision 0030); no generated `.env`, checklist
  output, or per-tenant artifact was ever committed under `scripts/operator/`.
- **Trust-scores** (`eval/trust-scores/*.json`, `scripts/ci/`): metric data only, no keys/
  URLs-with-credentials.
- **Mail/Haraka**: the intake token is env-injected; deploy compose requires it (`:?`).
- **Docs** (sessions/handoff/audits/runbook): placeholders (`<instance IP>`, `<domain>`)
  throughout; the audit docs discuss tokens but paste none.

The known dev placeholders (`cogeto-dev-password`, `MasterkeyNeedsToHave32Characters`,
`DevPassword1!`, the dev KMS key, `cogeto-dev-mail-token`, `'test-token'` fixtures) are
**sanctioned** — localhost-only defaults that `secret-preflight.ts` refuses to boot with on
a non-localhost host. **Verdict: CLEAN — no rotation or history rewrite needed.** One
narrow hardening follow-up surfaced (recorded as **PA-19** below).

**PA-19 — LOW — `cogeto-dev-mail-token` is not in the secret-preflight known-dev list.**
The dev compose default `cogeto-dev-mail-token` (`docker-compose.yml:108,588`) is **not**
among the values `secret-preflight.ts` (lines 32–43, postgres/minio/kms/zitadel only)
refuses to boot with on a non-localhost host. **Mitigation:** the pull-only deploy compose
hard-requires `COGETO_MAIL_INTAKE_TOKEN` (`:?`) and the operator script generates it, so a
supported customer install cannot ship the dev value — only a hand-rolled non-localhost
deploy of the *dev* compose could. **Remedy:** add
`{env:'COGETO_MAIL_INTAKE_TOKEN', devValue:'cogeto-dev-mail-token', match:'equals'}` to the
preflight list — **automated**, one line.

---

## Findings summary

| ID | Sev | Area | One-line |
|---|---|---|---|
| PA-1 | HIGH | Tag protection | No `v*` tag ruleset — release tags deletable/movable |
| PA-12 | HIGH | Repo security | Secret scanning + push protection disabled (free for public) |
| PA-18 | INFO (CLEAN) | Git history | No secret/private artifact in 94-commit history — safe to publish |
| PA-2 | MEDIUM | Actions | `id-token: write` workflow-scoped, not job-scoped |
| PA-3 | MEDIUM | Actions | Two `pull_request_target` workflows expose write tokens |
| PA-6 | MEDIUM | Actions | Third-party actions pinned by mutable tags, not SHAs |
| PA-5 | MEDIUM | Deps | Dependabot security updates off; no `dependabot.yml` |
| PA-8 | MEDIUM | Secrets | `PROJECTS_TOKEN` scope/expiry unverified, broadly exposed |
| PA-13 | MEDIUM | Repo | `require_code_owner_review` on but no CODEOWNERS |
| PA-15 | MEDIUM | Org | 2FA not enforced org-wide |
| PA-4 | MEDIUM→LOW | Branch protection | Admins bypass the ruleset `always` |
| PA-7 | LOW | Docker Hub | Confirm `DOCKERHUB_TOKEN` is scoped push-only |
| PA-9 | LOW | Branch protection | Merge/rebase merges allowed (repo is squash-only) |
| PA-10 | LOW | CI | Missing Mistral key soft-skips the launch gate green |
| PA-11 | LOW | Projects | Board is public — confirm intent |
| PA-14 | LOW | Repo | Merged branches not auto-deleted |
| PA-16 | LOW | Docker Hub | Overviews blank on all three images |
| PA-17 | LOW | Docker Hub | Tags mutable (semver tags overwritable) |
| PA-19 | LOW | Secrets | `cogeto-dev-mail-token` missing from secret-preflight list |
| PA-18 | INFO | Git history | CLEAN — no secret in history (§8) |

*(PA-9 detail: the ruleset's `allowed_merge_methods` permits `merge` and `rebase` in
addition to `squash`, but the documented convention is squash-only "PR title → single
commit on main." Restrict to `["squash"]` — owner-only, ruleset.)*

**Severity roll-up (platform audit): CRITICAL 0 · HIGH 2 (PA-1, PA-12) · MEDIUM 8
(PA-2, PA-3, PA-4, PA-5, PA-6, PA-8, PA-13, PA-15) · LOW 8 (PA-7, PA-9, PA-10, PA-11,
PA-14, PA-16, PA-17, PA-19) · INFO 3 (PA-18 CLEAN git history; Discussions off; org
members can create repos).** The two HIGH items — tag protection and secret scanning /
push protection — are the launch blockers to clear first; both are owner-actionable in a
web UI within minutes. The git-history sweep (PA-18) is **CLEAN**: nothing to rotate or
rewrite.
