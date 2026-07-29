# CI/CD setup — what was created, and what the owner must finish

This note records the CI/CD pipeline and engineering-workflow tooling added for
Cogeto, and the **manual steps only the owner can complete** (secrets, branch
protection, project-board toggles, cutting the first release). Everything below
is pipeline and tooling — no product code, schema, or business logic.

## What was created

**Docs**

- `docs/engineering-workflow.md` — the delivery loop: branch naming, Conventional
  Commits, squash-merge, `Closes #N`, required checks, tag-driven releases, and
  the `create-issues.sh` helper.
- `CLAUDE.md` — added a "Delivery loop" section + a doc-map pointer.
- `AGENTS.md` — noted commits/PRs are always authored as the owner.

**Version consistency**

- `scripts/ci/verify-version.mjs` + `npm run verify:version` — asserts a `vX.Y.Z`
  tag equals `package.json` `version`; fails the release build on mismatch. No
  `VERSION` file; the tag and `package.json` are the two sources of truth.

**Workflows**

- `.github/workflows/ci.yml` — runs on every PR and on push to `main`. Jobs:
  `lint`, `boundaries`, `test`, `build`, `eval-gate` (the five **required**
  checks), plus `docker-build` (amd64, no push — keeps the Dockerfile green; not
  required). npm cache via `setup-node`; Docker layers via the GHA cache. The
  `eval-gate` keeps its secret-gated behaviour (mocked on PRs incl. forks; live
  golden-set on push to `main`). The old standalone `eval-gate.yml` was folded
  into `ci.yml` so the required check reports on every PR.
- `.github/workflows/release.yml` — triggered by a `v*.*.*` tag: `verify:version`
  → build amd64 once → push `cogeto/cogeto:X.Y.Z` + `:latest` to Docker Hub →
  keyless **cosign** sign + **SBOM** (SPDX) attestation and release asset →
  GitHub Release with notes grouped by Conventional-Commit type and a `cosign
  verify` footer.
- `.github/release.yml` — maps type labels to release-note sections (Features /
  Fixes / Documentation / Chores / Other).
- `.github/workflows/project-automation.yml` — moves board cards on issue/PR
  events. No-ops without the `PROJECTS_TOKEN` secret (see below).

**Helpers**

- `scripts/dev/create-issues.sh` — idempotent `gh` helper that creates the
  logically separated issues for a unit of work under a shared label. Usage is
  documented in `docs/engineering-workflow.md`.

**GitHub state already created by this setup**

- Labels: `feat`, `fix`, `docs`, `chore` (for release-note grouping).
- Project (v2) board **Cogeto** — <https://github.com/orgs/Cogeto/projects/1> —
  with Status options **Todo → In Progress → In Review → Done**.

---

## ✅ Manual checklist — owner only

These require owner privileges or secrets and were **not** done automatically.

### 1. Repository secrets

Add under **Settings → Secrets and variables → Actions**:

- [ ] `DOCKERHUB_USERNAME` — Docker Hub account/org that owns `cogeto/cogeto`.
- [ ] `DOCKERHUB_TOKEN` — Docker Hub access token with **Read/Write** to
      `cogeto/cogeto`.
- [ ] `MISTRAL_API_KEY` — already required by the eval gate; confirm it is
      present (the live golden-set gate on `main` skips loudly without it).
- [ ] `PROJECTS_TOKEN` — a **fine-grained PAT** for board automation:
      Organization permissions → **Projects: Read and write** (and Repository →
      Issues/Pull requests: Read). Without it, `project-automation.yml` no-ops.

### 2. Branch protection on `main`

**Settings → Branches → Add rule** for `main`:

- [ ] Require a pull request before merging.
- [ ] Require status checks to pass; select exactly these five contexts:
      **`lint`, `boundaries`, `test`, `build`, `eval-gate`**.
- [ ] Require branches to be up to date before merging (recommended).
- [ ] **Allow squash merging only** — under **Settings → General → Pull
      Requests**, enable *Squash merging*, disable *Merge commits* and
      *Rebase merging*. Set "Default commit message" to **"Pull request title"**
      so the PR title becomes the single commit on `main`.

> The five contexts only appear in the picker after they have run at least once
> — the smoke-test PR (below) makes them available.

### 3. Docker Hub

- [ ] Ensure the `cogeto/cogeto` repository exists on Docker Hub (or that the
      token's account may auto-create it on first push).

### 4. Project board automation

The board and its columns exist. Choose **one**:

- **A — code-controlled (recommended, matches the requested transitions):** add
  the `PROJECTS_TOKEN` secret (step 1). `project-automation.yml` then adds new
  issues/PRs to the board and moves them Todo → In Progress (linked PR opens) →
  In Review (ready-for-review) → Done (merge/close).
- **B — built-in Projects workflows (no secret):** open the board →
  **⋯ → Workflows** and enable *Auto-add to project* (filter `is:issue,is:pr,
  is:open`), *Item added → Todo*, *Item closed → Done*, *Pull request merged →
  Done*. Note the built-ins have no "linked-PR-opened → In Progress" or
  "ready-for-review → In Review" trigger — option A is required for those.

### 5. Cut the first release (when ready — do NOT let CI do this)

- [ ] Land a `chore: release vX.Y.Z` PR bumping `package.json` `version`.
- [ ] On `main`, tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`
      (tag must equal `package.json`; `verify:version` enforces it).
- [ ] Watch `release.yml`: image pushed, signed, SBOM attached, Release created.
- [ ] Verify the published image:
      ```sh
      cosign verify cogeto/cogeto:X.Y.Z \
        --certificate-identity-regexp '^https://github.com/Cogeto/cogeto/\.github/workflows/release\.yml@refs/tags/' \
        --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
      ```

### 6. Smoke-test PR

- [ ] A PR from `ci/pipeline-smoke` (docs + workflows + tooling only) is open for
      you to review and merge once the five checks are green. It exists so the
      required-check contexts appear in the branch-protection picker.

---

## Notes / decisions

- **`eval-gate` as a required check:** it must report on every PR or branch
  protection would block merges waiting for it. It therefore runs on all PRs
  (mocked, no key) and lives in `ci.yml`; the live spend happens only on push to
  `main`. The key never touches a PR branch (QS-15 preserved).
- **`docker-build` is intentionally not required** — it guards the Dockerfile but
  building under emulation is slow; a broken Dockerfile is caught, not gating.
- **No `v*` tag was pushed** by this setup — the owner cuts the first release.
