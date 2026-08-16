# Dependabot triage, 2026-08-15

Phase 1 analysis of the 27 open Dependabot pull requests. Read-only: nothing has
been merged, closed, or changed. Buckets: Safe, Safe as a group, Review, Risky
major, Hold.

## Two structural findings that drive most buckets

**1. Every container digest PR is tracking the wrong tag.** The pins are bare
digests (`image: node@sha256:...`) with the tag only in a comment, and
Dependabot's docker ecosystem therefore follows `latest`, not the commented
tag. Verified against Docker Hub: every "new" digest in the ten open docker PRs
resolves to the repository's `latest` tag (node `latest` is Node 26 on Debian,
caddy `latest` is Debian-based, qdrant `latest` is v1.19.0, python's target no
longer matches any current tag), while the old pinned digests are, for caddy,
busybox and qdrant, still the current digests of the commented tags. None of
the diffs refreshes the `# image:tag` comment, so merging any of them would
make the recorded tag a lie, and the two that are green in CI (#547 caddy,
#552 python) are the most dangerous because nothing stops them. The fix that
ends this permanently: pin as `image:tag@sha256:...` so Dependabot tracks the
intended tag; the guard at `project/src/entrypoints/deployment-hardening.spec.ts`
only requires `@sha256:` to be present, so the form passes.

**2. The redaction pip PRs are silent no-ops.** All five edit only
`requirements.txt`, but the image installs exclusively from the hash-locked
`requirements.lock` (`pip install --require-hashes`, SEC-12), which none of
them regenerates. Merging them changes nothing in the built image and creates
txt/lock drift. They can only land as one manual PR that bumps the pins and
regenerates the lock in the python:3.12 container per
`docs/operations/image-pins.md`.

Two more constraints found in CI: the `test` check enforces digest parity
between the dev and deploy compose files (`operator-script.spec.ts`), so a
compose bump on one side alone always fails, and the three deploy-compose PRs
also never regenerate `project/infra/deploy/deploy-assets.sha256`, which the
installer verifies. React 19 hard-refuses a react/react-dom version mismatch,
which is why #392 fails `test` until #393 lands first.

## The table

| PR | Package / image | Jump | Class | Dep kind | Checks | Bucket | Evidence and recommendation |
|---|---|---|---|---|---|---|---|
| #274 | actions/checkout 7.0.0 to 7.0.1, docker/login-action 4.4.0 to 4.6.0 | patch + minor | CI actions | CI only | green | Safe | SHA-pinned actions group, comments refreshed. Merge. |
| #555 | haraka 3.3.1 to 3.3.3 (services/mail) | patch | direct, runtime (mail image) | stale suite, needs rebase | Safe | Security release: sanitizes Message-ID, rDNS, HELO and CR/LF in logs (GHSA-4gxg-q43p-hfr2) in the service that ingests hostile SMTP. Own lockfile, conflicts with nothing. Rebase, then merge first. |
| #556 | mailparser 3.9.14 to 3.9.15 | patch | direct, runtime | green | Safe | Dependency refresh only (mailsplit, libmime, nodemailer) in the hostile-input mail parser; regression-safe direction. Merge, run the email specs. |
| #558 | pg 8.22.0 to 8.23.0 + @types/pg | minor | direct, runtime (drizzle driver, `infrastructure/db.ts`) | green | Safe | Single change: opt-in query pipelining, default path untouched. Testcontainers suite covers it. Merge. |
| #200 | @tanstack/react-query 5.101.3 to 5.101.4 | patch | direct, runtime (web) | green | Safe | Empty version-bump-only release. Merge. |
| #541 | dev-dependencies group: dependency-cruiser 18.2, eslint 10.8.1, prettier 3.9.6, typescript-eslint 8.67, @testcontainers/postgresql 12.1, @vitejs/plugin-react 6.0.5, axe-core 4.13, vite 8.2.1 | minor/patch x8 | all devDependencies | green | Safe | Tooling only; `lint`, `boundaries` and `test` are green on the PR, which is the exact exposure. Merge before #540 (adjacent-line conflict in two package.json files). |
| #540 | jsdom 29.1.1 to 30.0.1 (web dev) + @types/jsdom 27 to 30 (src dev) | major | devDependencies | green | Safe | Sole documented breaking change is the Node floor (>=22.22.2), which CI satisfies; `project/src` already ships runtime jsdom 30.0.1, so this aligns test env and types with production. Merge after #541 rebases. |
| #393 | react-dom + @types/react-dom 19.2.7 to 19.2.8 | patch | direct, runtime (web) | green | Safe as a group | Sibling of #392. One change upstream (RSC decoding perf), irrelevant to this Vite SPA. Merge FIRST. |
| #392 | react + @types/react 19.2.7 to 19.2.8 | patch | direct, runtime (web) | test FAIL | Safe as a group | Fails only because React 19 refuses react 19.2.8 beside react-dom 19.2.7. Merge #393, rebase, then merge. |
| #554 | @mistralai/mistralai 2.5.0 to 2.6.1 | minor | direct, runtime (model gateway) | green | Review | Speakeasy OpenAPI regen with no substantive changelog. Used surface (`chat.complete`, `chat.stream`, `embeddings.create`, `models.list` in `model-gateway/mistral.gateway.ts`) is stable core API. Check: `mistral-capabilities.spec.ts` plus one live probe before trusting it. No prompt changes, eval cache untouched. |
| #443 | i18next 25.10.10 to 26.3.6 | MAJOR | direct, runtime (web) | build/eval-gate/docker-build/scan FAIL | Risky major | v26 removes `initImmediate`; `project/web/src/i18n/index.ts:129` sets it, and the file depends on synchronous init so the first render has English in hand. Migration: rename to `initAsync: false` (valid on 25.x too), fix the v26 `init` typing error, verify no raw-key first paint, run the i18n-guard suite. 26.3.4+ also carries security hardening (deepExtend, ReDoS). Must land with #441. |
| #441 | react-i18next 16.6.6 to 17.0.11 | MAJOR | direct, runtime (web) | build/eval-gate/docker-build/scan FAIL | Risky major | 17.0.1 raised the i18next peer floor to >=26.0.1, so it cannot land without #443. The one behavioral break (Trans serialization of kept basic HTML tags) does not occur here: locales use `<b>`, `<q>`, `<link>` slots, never the kept-HTML list. Real work is ~30 TS errors from tightened namespace-generic `TFunction` variance (first at `GovernedMemories.tsx:106`). Supersede the pair with one manual migration PR. |
| #557 | qdrant digest (root compose) | v1.18.3 to latest = v1.19.0 | image, runtime | test FAIL (parity) | Hold | A version move disguised as a digest bump, comment left saying v1.18.3. `@qdrant/js-client-rest` is version-locked to the server (dependabot.yml ignore) and must move in lockstep, manually. Close. |
| #546 | qdrant digest (deploy compose) | same | image, runtime | test FAIL | Hold | Same, plus no `deploy-assets.sha256` regen. Close. |
| #551 | node digest (root compose) | 22-alpine to latest = 26 Debian | image, runtime | test FAIL (parity) | Hold | Two-major Node jump plus Alpine to Debian, comment untouched. The current pin IS a stale 22-alpine build, so a manual same-tag refresh across all pin sites is warranted instead. Close. |
| #544 | node digest (deploy compose) | same | image, runtime | test FAIL | Hold | Same, plus no manifest regen. Close. |
| #548 | node digest (infra Dockerfile) | same | image, runtime | docker-build + scan FAIL | Hold | Build breaks on `apk: not found`: direct proof the digest is not Alpine. Close. |
| #545 | node digest (mail Dockerfile) | same | image, runtime | docker-build FAIL | Hold | Same `apk` failure. Close. |
| #547 | caddy digest (infra Dockerfile) | 2-alpine to latest = Debian caddy | image, runtime | green | Hold | Old digest is still the current 2-alpine; nothing to refresh. Green checks hide an Alpine to Debian swap with a stale comment. Close. |
| #552 | python digest (redaction Dockerfile) | 3.12-slim to an orphaned non-3.12 digest | image, runtime | green | Hold | Target matches no current tag and is not 3.12-slim; the lock is hash-compiled for 3.12 wheels. Manual refresh to current 3.12-slim instead. Close. |
| #439 | busybox digest (root compose) | stable to latest | image, runtime | test FAIL (parity) | Hold | Old digest is still current `stable`; nothing to update. Close. |
| #438 | busybox digest (deploy compose) | same | image, runtime | test FAIL | Hold | Same, plus no manifest regen. Close. |
| #553 | spacy 3.8.13 to 3.8.15 (redaction) | patch | direct, runtime (sidecar) | stale suite | Hold | Change is safe (3.8.15 satisfies presidio's `!=3.8.14` pin, model wheel range ok, click already locked) but the PR never touches `requirements.lock`, so it is a no-op for the image. Fold into the one manual lock-regen PR. |
| #440 | uvicorn 0.51.0 to 0.52.1 (redaction) | minor | direct, runtime (sidecar) | stale suite | Hold | Changes are websocket and opt-in parser work the plain-HTTP service never exercises. No-op without lock regen; fold into the manual PR. |
| #287 | fastapi 0.139.2 to 0.141.1 (redaction) | minor span | direct, runtime (sidecar) | stale suite | Hold | No breaking changes in the range; service uses only two POST routes and a health GET. No-op without lock regen; fold into the manual PR, eyeball the recompiled starlette pin. |
| #195 | presidio-analyzer 2.2.363 to 2.2.364 (redaction) | patch | direct, runtime (sidecar) | stale suite | Hold | Recognizer pattern fixes; used APIs stable. Move with #194. No-op without lock regen; fold into the manual PR, run `tests/test_presidio.py` on the rebuilt image. |
| #194 | presidio-anonymizer 2.2.363 to 2.2.364 (redaction) | patch | requirements-only (nothing imports it) | stale suite | Hold | Inert for app code, but carries the one real security value in the pip set: bumps transitive `cryptography` to 48.x for GHSA-537c-gmf6-5ccf. Fold into the manual PR; optionally ask the owner whether the unused dependency should be dropped instead. |

Counts: Safe 7, Safe as a group 2, Review 1, Risky major 2, Hold 15.

## Named groups

- **react pair**: #393 + #392. React 19 refuses mismatched react/react-dom.
  Order matters: #393 alone is green, #392 alone is red, so #393 first.
- **i18n pair**: #443 + #441. Hard peer floor (react-i18next 17 requires
  i18next >=26.0.1). Cannot land separately; both need code changes, so one
  manual migration PR supersedes both. This deviates from the one-major-per-PR
  rule only because the peer dependency makes them a single indivisible change.
- **node image family**: #551 + #544 + #548 + #545, one digest across six pin
  sites in four files, forced together by the dev/deploy parity guard. All
  four target the wrong image entirely; the family is closed as a family.
- **qdrant pair** (#557 + #546) and **busybox pair** (#439 + #438): parity
  forced, both closed.
- **redaction pip set**: #553 + #440 + #287 + #195 + #194, superseded by one
  manual lock-regen PR (presidio analyzer and anonymizer stay at the same
  version, released in lockstep upstream).
- **conflict, not a group**: #541 and #540 edit adjacent lines in
  `project/web/package.json` and `project/src/package.json`; merge #541,
  let Dependabot rebase #540.

## The majors

**i18next 26 + react-i18next 17** (one manual PR). Migration:
1. `project/web/src/i18n/index.ts:129`: `initImmediate: false` becomes
   `initAsync: false`, and the surrounding comment updates; v26 silently
   ignores the old name, which would defer init and flash raw keys on first
   paint, exactly what that file exists to prevent.
2. Fix the v26 `init` options typing error (`i18n/index.ts:114`).
3. Fix ~30 `TFunction` namespace-variance errors in helpers that accept a
   namespaced `t` (first at `components/GovernedMemories.tsx:106`).
4. No locale file changes: the Trans kept-HTML serialization break does not
   occur in these locales (verified: no `<br>`, `<strong>`, `<i>`, `<p>` in
   copy).
5. Verify: full suite, `npm run i18n:check`, the i18n-guard spec, a real
   stack walk confirming no raw-key first paint in a non-English locale.

**jsdom 30** (#540): major in name; the only documented break is the Node
floor, already satisfied. Bucketed Safe above.

## What Dependabot is not covering, and configuration proposals

- **Zitadel is very stale**: pinned v2.65.1, upstream is v4.17.1. This is the
  identity provider, the exact failure mode the dependabot.yml header cites.
  Earlier PRs (#301/#306) were closed unmerged and Dependabot has given up.
  Needs a deliberate, planned major migration, not a digest bump.
- **postgres 17-alpine** and **searxng** pins are stale same-tag builds
  (their refresh PRs were closed unmerged); **minio/mc** are current.
- **Proposal 1 (root cause)**: convert every pin to `image:tag@sha256:...` so
  Dependabot tracks the commented tag instead of `latest`. Passes the
  existing SEC-22/SEC-35 guard unchanged. Until this lands, every docker
  ecosystem PR is noise at best and an OS swap at worst.
- **Proposal 2**: merge the two docker-compose entries (and the docker
  entries) in `.github/dependabot.yml` using the multi-directory
  `directories:` key, so one image bump arrives as one PR satisfying the
  dev/deploy parity guard. Note the deploy manifest
  (`deploy-assets.sha256`) still needs a manual regen, so compose bumps
  remain a manual finish even then.
- **Not automatable**: the redaction lock (`pip-compile --generate-hashes`)
  and the qdrant client/server lockstep stay manual by design.

## Proposed merge order (Phase 2, on approval)

1. #274 (actions, isolated).
2. #555 (haraka security fix; `@dependabot rebase` first so
   `operator-smoke-fast` runs; own lockfile).
3. Root-lockfile chain, rebasing between merges: #556, #200, #558, #541,
   #540, #393, then #392.
4. #554 after the mistral capabilities spec and a live probe (Review).
5. Manual PR A: redaction pip set (five pins + lock regen + comment update at
   `requirements.txt:12`), closing #553 #440 #287 #195 #194.
6. Manual PR B: i18n pair migration, closing #443 #441.
7. Close all ten docker PRs with the reason above; separate manual chore to
   refresh node 22-alpine, python 3.12-slim, postgres 17-alpine and searxng
   digests with true comments plus `deploy-assets.sha256` regen; plan zitadel
   and qdrant moves deliberately.
8. Config PR: dependabot.yml `directories:` grouping and, if the owner
   agrees, the `tag@sha256` pin form.

Every merge invalidates the remaining root-lockfile PRs' checks; each needs
its rebase to go green before merging, and required checks are never
bypassed.

## Staleness and support audit (added 2026-08-15, after the owner's question)

Why none of this surfaced earlier: the bare-digest pins meant Dependabot
tracked `latest` and produced junk PRs that were rightly closed, the npm
open-PR limit of 10 was saturated so routine bumps (NestJS) never opened,
and nothing anywhere measured version AGE or support status. The pin-form
fix stops the junk; this audit is the missing age check.

| Component | We run | Latest | Supported? | Risk | Priority |
|---|---|---|---|---|---|
| Zitadel | v2.65.1 (2024-11-15) | v4.17.1 (2026-08-14) | NO, v2 is EOL | Critical: post-2.65.1 fixes include an Admin API IDOR (CVE-2025-27507), account takeover via session fixation bypassing MFA, expired JWT keys usable for grants, auth-factor brute force (CVE-2025-64101/64102). This is the internet-facing login. | 1, plan now |
| MinIO + mc | 2025-09-07 image | community archived 2026-04 | NO, dead upstream | CVE-2025-62506 (8.1, STS privilege escalation) has no community image with the fix, and never will. Internal-only in this stack, so exploitation needs a foothold first, but the gap only grows. | 2, decide direction |
| DOMPurify | 3.4.12 | 3.4.13 | yes | Moderate XSS advisory (GHSA-55q2-fjhq-7xh7) in the sanitizer the hardening relies on; fix is one patch. | quick fix |
| nanoid (transitive) | <3.3.18 | fixed line | yes | High advisory, infinite loop; `npm audit fix` clears it. | quick fix |
| Qdrant | v1.18.3 (2026-07-17) | v1.19.0 (2026-08-04) | yes | One security fix in 1.19.0 (path traversal in S3 snapshots, not used here). Client moves in lockstep. | low, deliberate minor |
| Node 22 images | 22.x digest (stale build) | 22.23.2 | Maintenance LTS to 2027-04-30 | Fine; refresh the digest, plan Node 24 before 2027. | digest refresh |
| Postgres 17 | 17.x digest | 17.11 (2026-08-10) | yes, to 2029-11-08 | Fine; keep the minor current. | digest refresh |
| Python 3.12 | 3.12.x digest | 3.12.14 (2026-08-12) | security-only to 2028-10-31 | Fine; security releases still flow, keep the image fresh. | digest refresh |
| Caddy 2 | 2-alpine digest | 2.11.4 | yes | Current pin IS current 2-alpine. | none now |
| BusyBox | stable (1.37.0) | 1.37.0 (2024-10) | yes, slow upstream | Nothing newer exists. | none |
| SearXNG | 2026.7.19 build | daily rolling | rolling | A month behind mostly means broken search engines, not CVEs. | refresh monthly |
| NestJS | 11.1.28 | 11.2.1 | yes | Routine minor, was starved by the open-PR limit. | with next chore |
| TypeScript, @types/node, qdrant client | pinned back | majors ahead | yes | Deliberate, recorded ignores in dependabot.yml. | as designed |

Zitadel upgrade path per the official docs: majors are not skippable;
2.65.1 to 2.71.18, then latest v3, then v4, with the stepwise idempotent
setup migrations run at each stage and a tested walk before customers.
License note: v3 moved from Apache-2.0 to AGPL-3.0, which matters to the
self-hosted offering and needs the owner's eyes.

MinIO options, in rough order of effort: build the 2025-10-15 fix tag into
an own image; adopt a maintained fork or a hardened third-party build;
migrate the object layer to a maintained store. The stack talks to it via
the S3 API behind one seam, so a migration is bounded, but it is a project,
not a bump.

## Execution record

**2026-08-15, wave 1 (the original 27 PRs).** PR #606 (owner-merged) landed
every Safe and Safe-as-a-group bump in one batch: pg + @types/pg, mailparser,
haraka 3.3.3 (security), react + react-dom 19.2.8, @tanstack/react-query,
jsdom 30 + @types/jsdom, the eight dev-tool bumps, and the two actions SHA
bumps. The ten docker digest PRs were closed (all tracked `latest`, not the
pinned tag). PR #607 (owner-merged) removed the cause: every pin now carries
its tag in the reference, the hardening spec requires the tagged form, the
Dependabot docker entries are multi-directory, and the deploy manifest was
regenerated. The nine superseded npm and actions PRs closed.

**2026-08-15, wave 2 (post-#607 re-scan).** With tags visible, Dependabot
proposed honest version moves. PR #623 landed the safe bucket: dompurify
3.4.13 (XSS advisory GHSA-55q2-fjhq-7xh7), the @nestjs trio 11.1.29, mammoth
1.12.1, the @testcontainers lockfile completion, and nanoid 3.3.18 via npm
audit fix; npm audit is now clean. Closed with reasons: the zitadel v2 to v4
pair (#614, #620; majors are not skippable, the migration is planned work),
the node 26-alpine family (#617, #622, #609, #610; Node 22 LTS is
deliberate), and python 3.14-slim (#611; the hash lock is compiled for 3.12).

**Deliberately pinned, so they stop resurfacing**: Node 22 (until a planned
Node 24 move before 2027-04), python 3.12-slim (to 2028-10), Zitadel v2
(until the staged migration), qdrant server + client (lockstep, manual),
TypeScript major, @types/node major.

**Lessons the next config change should encode** (config round 2, proposed):
a `groups:` block on the docker-compose entry so a shared image arrives as
ONE cross-directory PR that can satisfy the parity test; `ignore` rules for
node, python and zitadel majors; and dropping the now-redundant tag comment
above each pin (the tag lives in the reference) with the spec tightened to
match, so an honest bump no longer leaves a stale comment behind.

**Open at the end of 2026-08-15**: #615 + #621 (qdrant v1.19.0, waiting on
the manual lockstep chore with the npm client), #554 (mistral SDK, Review),
#553/#440/#287/#195/#194 (the pip set, superseded by the manual lock-regen
PR when it lands), #443 + #441 (the i18n major pair, manual migration PR).
Off-Dependabot work tracked above: the Zitadel migration (priority 1), the
MinIO decision (priority 2), the same-tag digest refresh chore, and the
Node 24 horizon item.

## Local batch, 2026-08-16 (owner-directed fast path)

The owner chose local verification with a direct push to master over serial
PR cycles, and evals skipped (nothing here touches a prompt or extraction
behaviour; the post-push CI run on master still runs the cached eval-gate as
a backstop). Four logical commits, each verified locally before the next:

1. **Images, qdrant lockstep, config round 2.** Qdrant server v1.19.0 in
   both composes, the test harness, AND `@qdrant/js-client-rest` 1.19.0
   together; client 1.19 removed the deprecated `search`, so the one call
   site (`memory/persistence/vector-store.ts`) moved to the universal
   `query` API, proved by the full memory + retrieval suites (205 tests)
   against a real v1.19.0 container. Same-tag digest refreshes: node
   22-alpine, postgres 17-alpine, python 3.12-slim, searxng (now pinned to
   its dated build tag). The redundant tag comments above pins are GONE:
   the tag lives in the reference and the SEC-35 spec now asserts exactly
   that, so a stale comment is structurally impossible. Dependabot got
   `groups` blocks (one PR per ecosystem wave) and `ignore` rules for
   node/python/zitadel/qdrant version moves taken deliberately.
   `deploy-assets.sha256` regenerated; `image-pins.md` updated. Closes
   #615, #621 by supersession.
2. **@mistralai/mistralai 2.6.3.** Model-gateway suites (178 tests) plus a
   live probe of the exact used surface (models.list, embeddings 1024-dim,
   chat.complete, chat.stream) against the real API. Closes #554.
3. **Redaction pip set.** fastapi 0.141.1, uvicorn 0.52.1, presidio
   2.2.364 pair, spacy 3.8.15; requirements.lock regenerated with hashes in
   the pinned python:3.12 container (63 pins; cryptography landed at 48.0.1,
   the GHSA-537c-gmf6-5ccf fix), dry-run hash install verified, image
   rebuilt, all 8 sidecar tests pass inside it. Closes #553, #440, #287,
   #195, #194.
4. **i18next 26.3.6 + react-i18next 17.0.11.** `initImmediate` became
   `initAsync` (v26 removed the old name; synchronous first paint kept).
   The feared ~30 TFunction errors were an artifact of the peer mismatch on
   the solo Dependabot PR; with both majors together the web workspace
   typechecks clean. Web suite 186 tests, i18n:check, build all green.
   Closes #443, #441.

Final gauntlet before push: lint, boundaries, full server suite, compose
smoke, and a browser walk in Croatian for the i18n pair.
