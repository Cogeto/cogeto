# Dependabot triage (2026-07-19)

Phase 1 analysis of the 15 open Dependabot PRs (#101-#115). Read-only: no
branches, merges, or code changes were made. CI status is as of 2026-07-19
(check runs re-executed today, so the states below are current against main
at v1.0.4). Buckets: SAFE / SAFE-BATCH / REVIEW / RISKY-MAJOR / HOLD.

## Summary table

| PR | Package | From -> To | Class | Where it ships | CI | Bucket | Recommendation |
|---|---|---|---|---|---|---|---|
| #105 | haraka-constants | 1.0.7 -> 1.0.8 | patch | cogeto-mail image | green | **SAFE** | Merge. Doc/engine-field-only release, no API change. |
| #114 | drizzle-orm | 0.44.7 -> 0.45.2 | 0.x minor | runtime image | green | **REVIEW** | Merge now. No documented breaking change; includes a SQL-injection fix. |
| #111 | pino | 9.14.0 -> 10.3.1 | major | runtime image | green | **REVIEW** | Merge. Only breaking change is dropping Node 18; we run Node 22. |
| #112 | graphile-worker | 0.16.6 -> 0.17.3 | 0.x minor (breaking) | runtime image | green | **REVIEW** | Merge with ops note: one-way DB migration, back up first. |
| #108 | actions group (7 bumps) | majors (checkout/setup-node v4->v7, docker v6->v7 etc., cosign-installer v3->v4) | major | CI + release signing | green | **REVIEW** | Do NOT merge as-is: cosign-installer v4 signs with cosign 3.x while customers verify with pinned cosign 2.4.1. Supersede with an owner PR that pins `cosign-release`. |
| #107 | Haraka | 3.1.0 -> 3.3.1 | minor (breaking for plugins) | cogeto-mail image | green (vacuous) | **REVIEW** | Do NOT merge as-is: 3.3.1 removes the `.address()` method shim; our rcpt plugin would DENY all inbound mail. Supersede with plugin patch + SMTP smoke. |
| #110 | @mistralai/mistralai | 1.15.1 -> 2.5.0 | major | runtime image | green (eval mocked on PRs) | **RISKY-MAJOR** | Worth doing, alone: ESM-only SDK in a CJS build; needs `gateway:smoke` + watching the live eval gate on main. Blast radius is one file. |
| #113 | zod | 3.25.76 -> 4.4.3 | major | runtime image | **red** (build/test) | **RISKY-MAJOR** | Defer to a dedicated migration PR; ~15 files fail to compile today. |
| #109 | dev-dependencies group (11 bumps) | mixed, incl. 6+ majors (TS 7, ESLint 10, Vitest 4, Vite 8...) | major | dev only | **red** (all jobs) | **HOLD** | Close. `npm ci` fails on ERESOLVE (typescript@7 vs typescript-eslint peer `<6.1.0`). Fix the group config; take bumps individually. |
| #101 | spacy | 3.7.5 -> 3.8.14 | minor | redaction image | green (vacuous) | **HOLD** | No-op as proposed (lock not updated) AND 3.8.14 is excluded by presidio 2.2.363. Fold into one manual redaction-refresh PR targeting spacy 3.8.13. |
| #102 | presidio-anonymizer | 2.2.355 -> 2.2.363 | patch | redaction image | green (vacuous) | **HOLD** | No-op as proposed (lock not updated). Fold into the manual redaction-refresh PR. |
| #103 | uvicorn | 0.30.1 -> 0.51.0 | 0.x minor (big range) | redaction image | green (vacuous) | **HOLD** | No-op as proposed. Fold into the manual redaction-refresh PR. |
| #104 | presidio-analyzer | 2.2.355 -> 2.2.363 | patch | redaction image | green (vacuous) | **HOLD** | No-op as proposed. Fold into the manual redaction-refresh PR. |
| #106 | fastapi | 0.111.0 -> 0.139.2 | 0.x minor (behavioral changes) | redaction image | green (vacuous) | **HOLD** | No-op as proposed. Fold into the manual redaction-refresh PR; re-check strict content-type and pydantic.v1. |
| #115 | @qdrant/js-client-rest | 1.14.0 -> 1.18.0 | minor | runtime image | green | **HOLD** | Deliberately exact-pinned to match the digest-pinned Qdrant server v1.14.0. Upgrade client and server together in a coordinated PR. |

Bucket counts: SAFE 1 · SAFE-BATCH 0 · REVIEW 5 · RISKY-MAJOR 2 · HOLD 7.

All PRs are direct dependencies of their respective manifests (root
devDependencies, `project/src` runtime deps, the mail and redaction service
manifests, or workflow files). None is a lockfile-only/transitive dedupe PR.

## Named batches

- **redaction-refresh (manual, supersedes #101, #102, #103, #104, #106).**
  These five cannot be merged individually or as-is at all, see HOLD details.
  One owner PR should bump `requirements.txt`, regenerate the hash-locked
  `requirements.lock` (pip-compile --generate-hashes in python:3.12, per
  SEC-12 / `docs/operations/image-pins.md`), bump the spaCy model wheel pin,
  and update the Dockerfile comment pins.
- **mail (supersedes #107; #105 can merge standalone first).** Haraka 3.3.1
  plus the plugin compatibility patch plus a local SMTP smoke test.
- No SAFE-BATCH group exists: the only pure-SAFE PR (#105) is independent
  (haraka-constants 1.0.8 works with Haraka 3.1.0).

## Evidence and detail per non-trivial PR

### #114 drizzle-orm 0.44.7 -> 0.45.2 (REVIEW -> merge now)

- Release notes for 0.45.0/0.45.1/0.45.2 document **no breaking changes**
  (the breaking work is all in the separate 1.0-beta line). 0.45.x fixes are
  node-postgres/pg-native transaction detection and Date mapping.
- 0.45.2 fixes a **SQL-injection (CWE-89) vulnerability** in
  `sql.identifier()` / `sql.as()`. We do not call either (verified by grep
  over `project/src`), but taking the fixed version is cheap hygiene.
- Blast radius: drizzle is imported in ~55 files, but the Testcontainers
  integration suites (deletion sagas, pipeline, queue) ran green on the PR,
  which exercises the ORM against a real PostgreSQL.
- Check on merge: none beyond the green suite.

### #111 pino 9.14.0 -> 10.3.1 (REVIEW -> merge)

- v10.0.0 release notes state the **only breaking change is dropping
  Node 18**. Runtime is Node 22 (`node:22-alpine` digest-pinned image,
  `engines >= 22`).
- Usage is the plain factory + child loggers across 7 files
  (`project/src/entrypoints/logger.ts` et al.); no transports or `censor`
  configs that the 10.1.0 typing change could touch.
- 10.2.x/10.3.x additionally fix transport memory leaks.

### #112 graphile-worker 0.16.6 -> 0.17.3 (REVIEW -> merge with ops note)

- 0.17.0 switches job locking from worker-id to **pool-centric** and adds DB
  migration 000019, a `--! breaking-change` **marker whose SQL is a no-op**
  (`select 1`). Migrations auto-run at worker start
  (`project/src/infrastructure/migrations.ts:4`).
- **Effectively one-way**: once migration 19 is recorded, a 0.16 worker
  refuses to start ("It would be unsafe to continue"). Rollback is not a
  supported path. Take a D4 backup before the first deploy of this version.
- Our API surface is unaffected: we use `run` (`project/src/entrypoints/worker.ts:154`),
  `runMigrations`, and the `Task` type only; none changed. We do not use
  `quickAddJob` (renamed), Worker Pro, or CLI defaults.
- Single-instance deployment means the "stop all 0.16 workers before starting
  0.17" requirement is naturally satisfied by the compose upgrade flow.
- Check on merge: normal upgrade flow; note the no-rollback property in the
  operator runbook entry for the release that ships this.

### #108 actions group, 7 bumps (REVIEW -> supersede)

- Six of the seven bumps are the same pattern: **move to the Node 24 action
  runtime** (needs Actions Runner >= 2.327.1, which GitHub-hosted runners
  have) plus ESM migration. Specifically verified against this repo:
  - `actions/github-script` v9: the inline board-sync script in
    `project-automation.yml` uses only the injected `github`/`core` objects,
    no `require()` and no `getOctokit` redeclaration, so it is compatible.
  - `actions/checkout` v7 blocks checking out fork-PR head refs in
    `pull_request_target` workflows; both such workflows here (`cla.yml`,
    `project-automation.yml`) are deliberately **checkout-free** (PA-3), so
    no impact.
  - `actions/setup-node` v5+ auto-caching triggers off a `packageManager`
    field; root `package.json` has none and `cache: npm` is explicit. No
    behavior change.
  - `docker/build-push-action` v7 removes two deprecated env vars we do not
    set.
- **The blocker is `sigstore/cosign-installer` v3.9.1 -> v4.1.2**: v4
  installs **cosign 3.x by default** (v4.1.2 defaults to v3.0.6). Release
  signing (`release.yml:161-163`) uses whatever the installer provides,
  while the customer-side operator script verifies with **cosign pinned at
  2.4.1** (`scripts/operator/cogeto:50`) and the security docs publish exact
  `cosign verify` commands. Cosign 3 defaults to the new sigstore bundle
  format; a signature-format regression here breaks customer verification of
  released images, which matters far more than action currency.
- Recommendation: supersede with an owner PR that applies all seven bumps
  but adds `cosign-release: v2.4.1` (or an explicit current 2.x) to the
  cosign-installer step, keeping signer and verifier in lockstep. Move to
  cosign 3 later as a coordinated change (workflow + operator script
  `COSIGN_VERSION` + docs + a verify test against a freshly signed image).

### #107 Haraka 3.1.0 -> 3.3.1 (REVIEW -> supersede; do not merge as-is)

- 3.2.0 replaced `address-rfc2821/2822` with `@haraka/email-address`:
  `rcpt.address()` (method) became `rcpt.address` (string property). 3.2.x
  kept a compat shim; **3.3.1 removed the shim**.
- Our custom plugins guard with `typeof rcpt.address === 'function'` and
  fall back to `''`:
  - `project/services/mail/haraka/plugins/cogeto_rcpt.js:13` then compares
    `'' === want` and returns **DENY for every recipient** - a silent,
    total inbound-mail outage.
  - `project/services/mail/haraka/plugins/cogeto_deliver.js:53-56` would
    forward empty from/rcpt values.
- CI is green only because nothing exercises SMTP at runtime (docker-build
  just builds the image).
- The upgrade itself is desirable: this service parses hostile internet
  input, and the 3.1.7+ line carries real hardening (HELO control-char
  rejection, AUTH credential redaction, STARTTLS buffer discard per
  RFC 3207, sanitized AUTH usernames).
- Also note: 3.1.2 raised the engine floor to Node 20 (fine), and the npm
  package was renamed `Haraka` -> `haraka` in 3.3.1 (Dependabot's diff
  handles the manifest; verify the Dockerfile/entrypoint invocation still
  resolves the `haraka` binary).
- Recommendation: owner PR that takes the bump AND patches both plugins to
  accept property-or-method (e.g. `typeof a.address === 'function' ?
  a.address() : a.address`), plus a local smoke: run the mail container,
  deliver a test message end-to-end, confirm intake. The first-install SMTP
  acceptance test from the runbook is the template.

### #110 @mistralai/mistralai 1.15.1 -> 2.5.0 (RISKY-MAJOR)

- v2 is **ESM-only** (CommonJS entry removed). The server compiles to
  CommonJS (`project/src/tsconfig.json:4`), so at runtime this relies on
  Node 22's `require(esm)` interop. PR CI is green - including build and
  unit tests - but the **eval-gate on PRs is the mocked path** (no live
  key), so the live SDK behavior (auth, streaming event shapes, retry
  classification) is unproven until it runs on main.
- Blast radius is deliberately tiny (the §A.10 seam): the SDK is imported in
  exactly one production file, `project/src/model-gateway/mistral.gateway.ts`
  (plus its spec). It uses `chat.complete`, `chat.stream`,
  `embeddings.create`, `models.list`, imports only the `Mistral` class (the
  v2 type renames do not touch us), and duck-types errors via
  `extractStatus` rather than SDK error classes.
- v2.5.0 declares `zod ^3.25.0 || ^4.0.0`, so it does not force the zod
  major (and v1.15.1 declares the same, so zod 4 does not force this PR
  either - the two majors are independent).
- Migration/verification plan if approved: merge alone; run
  `npm run gateway:smoke` against the live key; watch the live eval-gate +
  chat eval on the resulting main push; smoke the chat path in compose.
  Worth doing now (v1 line is current and the seam is small); an acceptable
  alternative is pinning `@^1` and deferring until the app builds ESM.

### #113 zod 3.25.76 -> 4.4.3 (RISKY-MAJOR, red CI)

- The build fails today with ~15 files of compile errors (docker-build log,
  2026-07-19): `ZodTypeDef` no longer exported (used in the gateway generic
  signatures: `model-gateway.service.ts`, `mistral.gateway.ts`,
  `budgeted.gateway.ts`, `redacting.gateway.ts`), `.deepPartial()` removed
  (`entrypoints/trust-scores.ts:101`), and inference regressions to
  `unknown`/`{}` across `ingestion/pipeline/extract.stage.ts`,
  `verify.stage.ts`, `retrieval/query-rewrite.ts`, `eval-chat.ts`,
  `eval-harness.ts`, `tasks/eval-tasks.ts`.
- zod 4 changes beyond compile errors that need review during migration:
  single-argument `z.record()` removed, error-customization params replaced
  by `error`, `.default()` semantics changed (now applies to output,
  short-circuits on undefined), `ZodError.errors` alias removed, stricter
  UUID validation. Zod sits at every boundary (~55 files import it), so the
  behavioral changes matter as much as the type errors.
- Ecosystem is not a blocker: `@mistralai/mistralai` (both v1 and v2)
  accepts zod 4. An incremental path exists: zod 3.25.x already ships the
  `zod/v4` subpath, and zod 4 retains `./v3`, so the migration can be staged
  file-by-file if preferred.
- Recommendation: defer; do it as a dedicated owner migration PR with the
  full suite + both eval suites (extraction schemas are zod - the eval gate
  is the real safety net here). It should be the last major in the sequence.

### #109 dev-dependencies group (HOLD -> close and reconfigure)

- All five required checks fail at `npm ci`: ERESOLVE because the group
  bumps `typescript` to 7.0.2 while also bumping `typescript-eslint` to
  8.64.0, whose peer range is `>=4.8.4 <6.1.0`.
- The group bundles at least six majors (TypeScript 5->7, ESLint 9->10 +
  @eslint/js, Vitest 3->4, Vite 7->8, @vitejs/plugin-react 4->6,
  dependency-cruiser 16->18, @testcontainers/postgresql 10->12,
  @types/node 22->26), which violates the one-major-per-PR rule this triage
  operates under and makes the PR unshippable as a unit.
- Recommendation: close #109, apply the Dependabot config change below so
  the dev group only bundles minor+patch, and let majors arrive as
  individual PRs to assess one at a time. TypeScript >= 6.1/7 should be
  ignored until typescript-eslint supports it.

### #101-#104, #106 pip / redaction sidecar (HOLD -> one manual PR)

- All five PRs modify **only `requirements.txt`**. The image installs
  exclusively from the hash-locked `requirements.lock` with
  `--require-hashes` (`project/services/redaction/Dockerfile`), which
  Dependabot does not regenerate. Merging them changes nothing in the
  shipped image and desynchronizes txt from lock.
- Additional blockers found for the set as proposed:
  - **presidio-analyzer 2.2.363 explicitly excludes spacy 3.8.14**
    (`spacy >=3.4.4, !=3.7.0, !=3.8.14, <4.0.0`), so #101 + #104 together
    cannot resolve. Target **spacy 3.8.13** instead.
  - spacy 3.8 requires the **3.8.0 model wheel**; the Dockerfile pins
    `en_core_web_lg-3.7.1`, whose metadata pins `spacy <3.8.0` - pip
    refuses to co-install. The model pin must move to
    `en_core_web_lg-3.8.0` in the same change (QS-25 procedure in
    `docs/operations/image-pins.md`).
  - fastapi range includes real behavior changes: 0.128 drops `pydantic.v1`
    support, 0.132 enables strict `Content-Type` checking by default
    (callers POSTing JSON without the header get rejected - verify the
    RedactingModelGateway client sets it), 0.118 moves yield-dependency
    teardown to after the response.
  - uvicorn range: watchgod/`Config.setup_event_loop` removals are
    irrelevant to our CLI usage; `colorama` left the `standard` extra in
    0.51.0; httptools floor is now >= 0.8.0 (lock regen handles it).
  - presidio 2.2.359 **disabled many country-specific recognizers by
    default** to cut false positives - review whether the redaction config
    relies on any (SgFin, Au*, In*, EsNif), and note 2.2.362 added regex
    execution timeouts (default 60 s).
- Recommendation: one owner "redaction dependency refresh" PR: bump
  requirements.txt (fastapi 0.139.2, uvicorn 0.51.0, presidio 2.2.363 x2,
  spacy **3.8.13**), regenerate requirements.lock with hashes in
  python:3.12, bump the model wheel to en_core_web_lg-3.8.0, run the
  redaction service tests + a compose smoke (the /health check loads the
  model, so a bad model pin fails loudly). Close the five Dependabot PRs as
  superseded.

### #115 @qdrant/js-client-rest 1.14.0 -> 1.18.0 (HOLD)

- The client is pinned **exact** (`"1.14.0"`, no caret) in
  `project/src/package.json`, matching the digest-pinned
  `qdrant/qdrant:v1.14.0` server in both compose files
  (`docs/operations/image-pins.md`). Upstream policy: client major.minor
  tracks the server; the client's startup compatibility check warns when
  minor skew exceeds 1 (1.18 client on 1.14 server logs an incompatibility
  warning; calls to 1.16+ API surface would fail server-side).
- Range contents: 1.16.0 removed the locks API, `init_from`, and
  `vectors_count` - none used by `project/src/memory/persistence/vector-store.ts`
  (basic upsert/search/scroll/retrieve/setPayload/delete only). Node floor
  now 18.17 (fine).
- Recommendation: hold; do a coordinated upgrade later (server image digest
  to v1.17/v1.18 + client to match + reindex smoke via `npm run reindex` +
  vector smoke), as its own PR. Until then this PR will keep reappearing;
  the config change below adds an ignore so it stops resurfacing.

## Proposed merge order (Phase 2, subject to owner approval)

1. **#105** haraka-constants (SAFE).
2. **#114** drizzle-orm - has the security fix, green integration suite.
3. **#111** pino.
4. **#112** graphile-worker - take a backup before the release that ships
   it; one-way migration.
5. **Owner PR superseding #108** - all seven action bumps + explicit
   `cosign-release: v2.4.1` pin.
6. **Owner PR superseding #107** - Haraka 3.3.1 + plugin address-property
   patch + SMTP smoke test.
7. **#110** @mistralai v2 - alone, with `gateway:smoke` + live eval watch
   on main.
8. **Owner PR superseding #113** - zod 4 migration, full suite + both eval
   suites; last major.
9. **Owner "redaction refresh" PR superseding #101-#104/#106** - spacy
   3.8.13 (not 3.8.14) + lock regen + model wheel 3.8.0.
10. **#115** later, coordinated with the Qdrant server image bump.

After each merge, remaining Dependabot PRs fall behind main; Dependabot
rebases them automatically (or on a `@dependabot rebase` comment). Current
merge states: #101/#105/#107/#108 are BEHIND; #110-#115 report BLOCKED
(required checks must re-run on the updated merge base - arm auto-merge
with `gh pr merge --auto --squash` rather than admin-merging, per the
established loop). Never merge while checks are pending; confirm main goes
green after each step before the next.

## Recommended Dependabot config change

Grouping is already partially in place; the failure modes seen here are
(a) majors bundled into the dev group, (b) a security-critical action
bundled into the actions group, and (c) pip PRs that cannot update the hash
lock. Concrete change to `.github/dependabot.yml`:

```yaml
# npm root: dev group only bundles minor+patch; majors arrive individually.
groups:
  dev-dependencies:
    dependency-type: development
    update-types: [minor, patch]
ignore:
  # typescript-eslint peer range caps TS; revisit when it supports TS >= 6.1.
  - dependency-name: typescript
    update-types: [version-update:semver-major]
  # Client is version-locked to the digest-pinned Qdrant server (image-pins.md);
  # upgraded manually in lockstep with the server image.
  - dependency-name: '@qdrant/js-client-rest'

# actions group: keep the signing toolchain out of the batch; its major
# changes the signature format customers verify with a pinned cosign.
groups:
  actions:
    patterns: ['*']
    exclude-patterns: ['sigstore/cosign-installer']
```

Optionally add a `production-minor-patch` group (dependency-type
production, update-types minor+patch) to cut the individual-PR noise
further; the current policy of reviewing production bumps individually
against the eval gate is also defensible - owner's call.

For pip, Dependabot cannot regenerate `requirements.lock` under its custom
name, so its PRs will stay reminder-only. Either keep them as reminders and
do a periodic manual refresh (status quo, documented here), or rename to
the convention Dependabot understands (`requirements.in` compiled to a
hash-locked `requirements.txt`) so it can update both - that requires a
Dockerfile and docs change and a decision record if adopted.

## Status

- 2026-07-19: Phase 1 complete. Owner approved wave 1 (the four green
  low-risk PRs) with a local-first verification loop: check out each PR
  branch, run lint + boundaries + full Vitest/Testcontainers suite + build
  locally, targeted smoke, owner sign-off, then approve + auto-merge on
  GitHub.
- 2026-07-19 wave-1 results:
  - **#105 haraka-constants: MERGED.** Extra local checks: mail image
    build, Haraka boot, full SMTP accept/deny handshake (script kept as
    the baseline test for the future Haraka 3.3.1 upgrade). Gotcha found:
    the original PR predated the mail lockfile on main and would have
    broken `npm ci` in the image build; a `@dependabot rebase` fixed it.
    Lesson: always rebase stale Dependabot PRs before judging them.
  - **#114 drizzle-orm 0.45.2: MERGED** (412/412 tests locally).
  - **#111 pino 10: MERGED** (412/412 tests locally).
  - **#112 graphile-worker 0.17.3: MERGED** (412/412 tests + full compose
    smoke: 8/8 services healthy, worker migrated + started, login page
    served). Follow-up candidate: attach an error handler to the pg Pool
    passed to the graphile runner in `project/src/entrypoints/worker.ts`
    to silence the new 0.17 "pool doesn't have error handlers" warning.
    Note: graphile schema migration is one-way; any environment whose DB
    ran the 0.17 worker cannot go back to a pre-#112 worker build.
- Merge mechanics learned: main ruleset requires 1 approving review +
  strict up-to-date branches, so each landing is rebase -> CI rerun ->
  owner approval -> auto-merge, serialized per PR. Reviews are dismissed
  on push, so approve only after the rebase lands.
- Token control: `MISTRAL_API_KEY` repo secret was DELETED on 2026-07-19
  (owner-approved) so wave-1 merges to main skip the live eval gate
  (it skips loudly by design). TO RESTORE: owner runs
  `gh secret set MISTRAL_API_KEY`, then re-run the eval-gate job on the
  latest main push (`gh run rerun <run-id> --job <eval-gate>`) for ONE
  live validation of the combined post-merge state. Until restored, no
  push to main runs the live golden-set/chat gates.
- 2026-07-19 wave-2 results (all verified locally before landing):
  - **#142 (supersedes #107, closed): MERGED.** Haraka 3.3.1 + plugin
    address-property patch; SMTP accept/deny + full DATA-to-intake
    verified against a stub; dependency tree 367 -> 106 packages. Note:
    owner-authored PRs cannot self-approve; they land via
    `gh pr merge --admin` once checks are green (the historical path).
  - **#110 Mistral SDK v2: verified + landing.** Compiles in the CJS
    build; ESM-only package loads via Node 22 `require()`; 25/25 mocked
    gateway tests; live structured-extraction smoke passed with the local
    key. Live streaming gets its validation from the end-of-wave eval
    rerun.
  - **#143 (supersedes #101-104/#106, closed): redaction refresh.**
    fastapi 0.139.2 / uvicorn 0.51.0 / presidio 2.2.363 / spacy 3.8.13 +
    model wheel 3.8.0; lock regenerated with hashes in python:3.12
    (63 packages); /health + pseudonymize/reidentify + 8/8 service tests
    green in-container.
  - **Actions + config PR (supersedes #108; closes #109):** all seven
    action SHA bumps applied to current workflows by hand (the stale
    Dependabot branch predated newer release.yml changes), with
    `cosign-release: v2.4.1` pinned on cosign-installer v4 so release
    signing stays verifiable by the operator script's cosign 2.4.1.
    dependabot.yml: dev group restricted to minor+patch, ignores added
    for typescript majors and @qdrant/js-client-rest.
  - The PR-#142 `test` failure was a flaky dead-letter integration case
    (`receipt_never_premature`) - passed untouched on rerun, and main was
    green on the same code. Watch for recurrence.
  - Main post-#114 eval-gate failure classified: extraction gate PASSED;
    chat gate failed on atlas_scope (documented grader variance since
    v0.9.2) + who_is_ana at 71% coverage. Not dependency-related; the
    end-of-wave rerun is authoritative.
- Remaining after wave 2: zod 4 migration (#113, dedicated session),
  Qdrant client+server coordinated bump (#115 stays open; ignore rule
  stops new client-only PRs), pg Pool error-handler follow-up, owner
  re-adds MISTRAL_API_KEY + one eval-gate rerun.
