# Engineering workflow

How work moves from an idea to `main` to a release in this repo. Concise and
binding. The architecture rules live in [`AGENTS.md`](../AGENTS.md); this is the
delivery loop around them.

## The delivery loop

Every unit of work follows the same loop:

1. **Open issues** for the unit of work — logically separated, each labelled.
   A "unit of work" (e.g. a roadmap session like O4) becomes several small
   issues under a shared label, not one giant issue. Use
   [`scripts/dev/create-issues.sh`](../scripts/dev/create-issues.sh) (below).
2. **Branch** from `main`: `feature/<slug>`, `fix/<slug>`, or `chore/<slug>`.
3. **Implement** on the branch.
4. **Open a pull request**, authored as the owner, with `Closes #N` in the body
   for every issue it resolves.
5. **Green checks** — the required checks must pass (below).
6. **Squash-and-merge** — the PR title becomes the single commit on `main`.
7. **Release** — the owner cuts releases by tagging (below). CI never tags.

All issue, branch, and pull-request operations are performed with `gh`,
authenticated as the owner. Nothing merges without green required checks.

## Branches

- `feature/<slug>` — new capability.
- `fix/<slug>` — bug fix.
- `chore/<slug>` — tooling, deps, CI, refactors, docs-only, and other
  non-feature work.

Keep `<slug>` short and kebab-cased, e.g. `feature/haraka-inbound`.

## Commits and pull-request titles — Conventional Commits

Release notes are generated from merged pull requests, so **titles matter**. Use
[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <summary>
```

Allowed types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`.

- `feat: add per-tenant Haraka inbound address`
- `fix: close validity interval on supersession`
- `ci: cache Docker layers in the release build`

Because we squash-merge, the **PR title is the commit** that lands on `main` —
write it as the Conventional Commit you want in the history and the changelog.
Label each PR with the label matching its type (`feat`, `fix`, `docs`,
`chore`, …) so the release notes group it correctly (see
[`.github/release.yml`](../.github/release.yml)).

## Pull requests

- **Squash-and-merge only.** No merge commits, no rebase-merge. One PR → one
  commit on `main`.
- **Author is always the owner** — Ivan Golubic `<ivan@themrcto.com>`. Never a
  bot identity, never a `Co-authored-by` trailer.
- **Link issues**: put `Closes #N` in the body for each issue the PR resolves. A
  PR may close several logically separated issues — list one `Closes #N` per
  issue.
- Keep PRs scoped to their unit of work.

## Required checks

These five checks must be green before a PR can merge (branch protection on
`main`):

| Check        | What it enforces                                                    |
| ------------ | ------------------------------------------------------------------- |
| `lint`       | ESLint + Prettier                                                   |
| `boundaries` | dependency-cruiser module map (§A.1) — no cross-module table access |
| `test`       | Vitest (unit) + Testcontainers (integration)                        |
| `build`      | backend compile (`tsc`) + Vite frontend build                       |
| `eval-gate`  | golden-set gate (§B.4) — prompt/model/pipeline regressions fail     |

A sixth CI job, `docker-build`, builds the production amd64 image without
pushing so the Dockerfile stays green; it is **not** required to merge.

The `eval-gate` is secret-gated (QS-15): pull requests run the mocked
build-only path (no API key, fork PRs run cleanly); the live golden-set gate
runs on push to `main` after merge.

### Product-copy dash guard (P6.8)

The `lint` check also enforces a house style rule: **no em (—) or en (–) dashes
in user-facing product copy.** A local ESLint rule
(`copy/no-typographic-dashes`, defined inline in `eslint.config.mjs`, no new
dependency) flags those characters in string literals, JSX text, and template
literals under `project/web/src`. It inspects only those AST nodes, so **code
comments are exempt** (they are out of scope and full of dashes). **Out of scope
and excluded:** the specs/fixtures, code identifiers and comments, third-party
output, user-entered data (including the seeded demo note bodies in
`project/demo/seed/`, which simulate a user's own writing), historical records
(audit entries, existing memories), backend log/error strings, docs authoring
notes (not served to users), and CLI/log output where a dash is syntax. Rewrite
each flagged dash with a comma, colon, period, or a restructured sentence, chosen
for natural reading, never a mechanical hyphen. `index.html` copy is kept clean by
hand (ESLint does not parse HTML).

## Versioning and releases

The **git tag** and **`package.json` `version`** are the two sources of truth and
**must agree**. There is no `VERSION` file.

- Check locally any time: `npm run verify:version`.
- Releases are **tag-driven**: pushing a `vX.Y.Z` tag that matches
  `package.json` triggers [`release.yml`](../.github/workflows/release.yml),
  which builds and pushes the amd64 image to Docker Hub
  (`cogeto/cogeto:X.Y.Z` + `:latest`), signs it with keyless cosign, attaches an
  SBOM, and creates the GitHub Release with notes grouped by Conventional-Commit
  type. A tag that does not match `package.json` fails the build before anything
  is published.
- **The owner cuts releases.** The typical flow: land a `chore: release vX.Y.Z`
  PR that bumps `package.json`, then the owner tags `vX.Y.Z` on `main`. CI never
  creates tags.

## Creating a unit of work's issues — `create-issues.sh`

[`scripts/dev/create-issues.sh`](../scripts/dev/create-issues.sh) creates the
logically separated issues for one unit of work under a shared label. It is
**idempotent** — re-running skips issues whose title already exists — so it is
safe to run again after editing the spec.

```sh
# One issue per line: "title | body" (body optional). Blank / #-comment lines
# are ignored. All issues get the shared label (created if missing).
scripts/dev/create-issues.sh <shared-label> <spec-file>

# Preview without creating anything:
DRY_RUN=1 scripts/dev/create-issues.sh o4-email issues.spec

# Read the spec from stdin:
scripts/dev/create-issues.sh o4-email - <<'SPEC'
O4 email: Haraka container in the compose stack | Receive-only SMTP, per-tenant.
O4 email: inbound parsing into the pipeline | Headers, body, attachments, invites.
O4 email: deletion saga covers email sources and receipts
SPEC
```

Options via env: `REPO` (target repo, defaults to the current origin),
`ASSIGNEE` (assign every created issue), `DRY_RUN=1` (print only). Requires `gh`
authenticated as the owner.

## Project board

Issues and pull requests are tracked on the **Cogeto** GitHub Project (v2)
board with columns **Todo → In Progress → In Review → Done**. Automation moves
cards: added to the board on open, **In Progress** when a linked PR opens,
**In Review** when a PR is marked ready-for-review, and **Done** on merge or
close. See [`docs/notes/cicd-setup.md`](notes/cicd-setup.md) for the board setup
and the one-time automation toggles.
